#include "DShowSoftcam.h"

#include <cstring>
#include <string>
#include <algorithm>
#include <cstdio>
#include <cmath>
#include <chrono>
#include <ctime>
#include <new>


namespace {

//#define ENABLE_LOG
//#define LOG_FILE_PATH "C:\\my_temp\\debug_log.txt"

#if defined(ENABLE_LOG)

FILE* logfile = nullptr;
#define OPEN_LOGFILE() logfile = std::fopen(LOG_FILE_PATH, "a")
#define CLOSE_LOGFILE() [&]{ \
        if (logfile) std::fclose(logfile); \
        logfile = nullptr; \
    }()
#define NOW() []{ \
        auto tp = std::chrono::system_clock::now(); \
        auto t = std::chrono::system_clock::to_time_t(tp); \
        static char buff[128]; \
        std::strftime(buff, sizeof(buff), "%H:%M:%S", std::localtime(&t)); \
        return buff; \
    }()
std::string IID_TO_STR(REFIID riid)
{
    std::string s =
            riid == IID_IPin                ? "IPin" :
            riid == IID_IBaseFilter         ? "IBaseFilter" :
            riid == IID_IAMovieSetup        ? "IAMovieSetup" :
            riid == IID_IQualityControl     ? "IQualityControl" :
            riid == IID_IAMStreamConfig     ? "IAMStreamConfig" :
            riid == IID_IKsPropertySet      ? "IKsPropertySet" :
            riid == IID_IAMFilterMiscFlags  ? "IAMFilterMiscFlags" :
            riid == IID_IPersistPropertyBag ? "IPersistPropertyBag" :
            riid == IID_IReferenceClock     ? "IReferenceClock" :
            riid == IID_IMediaSeeking       ? "IMediaSeeking" :
            riid == IID_IAMDeviceRemoval    ? "IAMDeviceRemoval" :
            riid == IID_IAMOpenProgress     ? "IAMOpenProgress" :
            riid == IID_IMediaPosition      ? "IMediaPosition" :
            riid == IID_IMediaFilter        ? "IMediaFilter" :
            riid == IID_IBasicVideo         ? "IBasicVideo" :
            riid == IID_IBasicAudio         ? "IBasicAudio" :
            riid == IID_IVideoWindow        ? "IVideoWindow" :
            riid == IID_IUnknown            ? "IUnknown" :
            [&]() -> std::string
            {
                char buff[128];
                snprintf(buff, sizeof(buff),
                    "{%08lX-%04hX-%04hX-%02hhX%02hhX-%02hhX%02hhX%02hhX%02hhX%02hhX%02hhX}",
                    riid.Data1, riid.Data2, riid.Data3,
                    riid.Data4[0], riid.Data4[1], riid.Data4[2], riid.Data4[3],
                    riid.Data4[4], riid.Data4[5], riid.Data4[6], riid.Data4[7]);
                return buff;
            }();
    return s;
}
#define LOG(fmt, ...) [&,funcname=__func__]{ \
        if (logfile) std::fprintf(logfile, "%s: %s " fmt, NOW(), funcname, __VA_ARGS__); \
        std::printf("%s: %s " fmt, NOW(), funcname, __VA_ARGS__); \
    }()

#else // ENABLE_LOG

#define OPEN_LOGFILE()
#define CLOSE_LOGFILE()
#define LOG(...)

#endif // ENABLE_LOG


using softcam::PixelFormat;
using softcam::PF_YUY2;
using softcam::PF_NV12;
using softcam::PF_I420;
using softcam::PF_RGB24;
using softcam::PF_COUNT;


// MEDIASUBTYPE_I420 lives in wmcodecdsp.h only; same layout as IYUV.
const GUID kSubtypeI420 =
    { 0x30323449, 0x0000, 0x0010, { 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71 } };

struct FormatInfo
{
    const GUID* subtype;
    DWORD       compression;    // biCompression: FOURCC for YUV, BI_RGB for RGB24
    WORD        bits;           // biBitCount
};

// Indexed by PixelFormat
const FormatInfo kFormats[PF_COUNT] =
{
    { &MEDIASUBTYPE_YUY2,  MAKEFOURCC('Y','U','Y','2'), 16 },
    { &MEDIASUBTYPE_NV12,  MAKEFOURCC('N','V','1','2'), 12 },
    { &kSubtypeI420,       MAKEFOURCC('I','4','2','0'), 12 },
    { &MEDIASUBTYPE_RGB24, BI_RGB,                      24 },
};

// What the filter advertises when no sender exists yet.
const int   DEFAULT_WIDTH = 1280;
const int   DEFAULT_HEIGHT = 720;
const float DEFAULT_FRAMERATE = 30.0f;

float sanitizeFramerate(float framerate)
{
    if (!(framerate > 0.0f))
    {
        return DEFAULT_FRAMERATE;
    }
    return (std::min)((std::max)(framerate, 1.0f), 240.0f);
}

REFERENCE_TIME frameDurationOf(float framerate)
{
    return (REFERENCE_TIME)std::llround(10000000.0 / sanitizeFramerate(framerate));
}

AM_MEDIA_TYPE* allocateMediaType()
{
    BYTE *pbFormat = (BYTE*)CoTaskMemAlloc(sizeof(VIDEOINFOHEADER));
    if (!pbFormat)
    {
        return nullptr;
    }

    AM_MEDIA_TYPE *amt = (AM_MEDIA_TYPE*)CoTaskMemAlloc(sizeof(AM_MEDIA_TYPE));
    if (!amt)
    {
        CoTaskMemFree(pbFormat);
        return nullptr;
    }
    std::memset(amt, 0, sizeof(*amt));
    amt->pbFormat = pbFormat;
    return amt;
}

// Fills `amt` (whose pbFormat already points to a VIDEOINFOHEADER-sized buffer).
// YUV formats: positive biHeight, which for YUV means top-down in DirectShow.
// RGB24: positive biHeight = bottom-up DIB.
void fillMediaType(AM_MEDIA_TYPE* amt, PixelFormat fmt, int width, int height, float framerate)
{
    BYTE *pbFormat = amt->pbFormat;
    const FormatInfo& fi = kFormats[fmt];

    const std::uint32_t image_size = (std::uint32_t)softcam::outputImageSize(fmt, width, height);
    const float fps = sanitizeFramerate(framerate);
    const float bit_rate = (float)image_size * 8.0f * fps;

    VIDEOINFOHEADER* pFormat = (VIDEOINFOHEADER*)pbFormat;
    std::memset(pFormat, 0, sizeof(*pFormat));
    pFormat->dwBitRate = (uint32_t)(std::min)(bit_rate, (float)INT_MAX);
    pFormat->dwBitErrorRate = 0;
    pFormat->AvgTimePerFrame = frameDurationOf(fps);
    pFormat->bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    pFormat->bmiHeader.biWidth = width;
    pFormat->bmiHeader.biHeight = height;
    pFormat->bmiHeader.biPlanes = 1;
    pFormat->bmiHeader.biBitCount = fi.bits;
    pFormat->bmiHeader.biCompression = fi.compression;
    pFormat->bmiHeader.biSizeImage = image_size;

    amt->majortype = MEDIATYPE_Video;
    amt->subtype = *fi.subtype;
    amt->bFixedSizeSamples = TRUE;
    amt->bTemporalCompression = FALSE;
    amt->lSampleSize = image_size;
    amt->formattype = FORMAT_VideoInfo;
    amt->pUnk = nullptr;
    amt->cbFormat = sizeof(VIDEOINFOHEADER);
    amt->pbFormat = pbFormat;
}

AM_MEDIA_TYPE* makeMediaType(PixelFormat fmt, int width, int height, float framerate)
{
    AM_MEDIA_TYPE *amt = allocateMediaType();
    if (!amt)
    {
        return nullptr;
    }
    fillMediaType(amt, fmt, width, height, framerate);
    return amt;
}

// Checks that `mt` is one of our formats at exactly the advertised size, and returns
// which one. Frame rate and bit rate fields are deliberately not compared: hosts
// often rewrite them.
bool parseMediaType(const AM_MEDIA_TYPE* mt, int width, int height,
                    PixelFormat* out_fmt, REFERENCE_TIME* out_frame_duration = nullptr)
{
    if (!mt ||
        mt->majortype != MEDIATYPE_Video ||
        mt->formattype != FORMAT_VideoInfo ||
        !mt->pbFormat ||
        mt->cbFormat < sizeof(VIDEOINFOHEADER))
    {
        return false;
    }
    int found = -1;
    for (int i = 0; i < PF_COUNT; i++)
    {
        if (mt->subtype == *kFormats[i].subtype)
        {
            found = i;
            break;
        }
    }
    if (found < 0 && mt->subtype == MEDIASUBTYPE_IYUV)
    {
        found = PF_I420;    // identical memory layout
    }
    if (found < 0)
    {
        return false;
    }
    const FormatInfo& fi = kFormats[found];
    const DWORD compression = (mt->subtype == MEDIASUBTYPE_IYUV) ? MAKEFOURCC('I','Y','U','V')
                                                                 : fi.compression;
    const VIDEOINFOHEADER* vih = (const VIDEOINFOHEADER*)mt->pbFormat;
    const BITMAPINFOHEADER& bi = vih->bmiHeader;
    if (bi.biWidth != width || bi.biHeight != height ||
        bi.biBitCount != fi.bits || bi.biCompression != compression)
    {
        return false;
    }
    *out_fmt = (PixelFormat)found;
    if (out_frame_duration)
    {
        *out_frame_duration = vih->AvgTimePerFrame;
    }
    return true;
}

// High resolution clock helpers for pacing and time stamps.
long long qpcNow()
{
    LARGE_INTEGER t;
    QueryPerformanceCounter(&t);
    return t.QuadPart;
}

long long qpcFrequency()
{
    static const long long f = []{ LARGE_INTEGER v; QueryPerformanceFrequency(&v); return v.QuadPart; }();
    return f;
}

REFERENCE_TIME ticksToRefTime(long long ticks)
{
    const long long f = qpcFrequency();
    return (ticks / f) * 10000000LL + (ticks % f) * 10000000LL / f;
}

long long refTimeToTicks(REFERENCE_TIME rt)
{
    return rt * qpcFrequency() / 10000000LL;
}

// Sleeps until the QPC time `deadline` (to within about a millisecond).
void sleepUntil(long long deadline)
{
    for (;;)
    {
        const double seconds = (double)(deadline - qpcNow()) / (double)qpcFrequency();
        if (seconds < 0.0015)
        {
            return;
        }
        softcam::Timer::sleep((float)(seconds - 0.001));
    }
}

bool allocateBuffer(std::unique_ptr<uint8_t[]>& buffer, std::size_t size)
{
    buffer.reset(new (std::nothrow) uint8_t[size]);
    return buffer != nullptr;
}

} //namespace

namespace softcam {


CUnknown * Softcam::CreateInstance(
                    LPUNKNOWN   lpunk,
                    const GUID& clsid,
                    HRESULT*    phr)
{
    OPEN_LOGFILE();
    LOG("===== logging started =====\n");

    return new Softcam(lpunk, clsid, phr);
}

Softcam::Softcam(LPUNKNOWN lpunk, const GUID& clsid, HRESULT *phr) :
    CSource(NAME("EvCam"), lpunk, clsid),
    m_width(DEFAULT_WIDTH),
    m_height(DEFAULT_HEIGHT),
    m_framerate(DEFAULT_FRAMERATE),
    m_format(PF_YUY2)
{
    // The filter is always usable. If a sender already exists, advertise its size and
    // rate (peeking has no side effect on the sender); otherwise use the defaults.
    // Whatever size is advertised, frames of any sender size are scaled to it.
    FrameBuffer::Info info;
    if (FrameBuffer::peek(&info) && info.active)
    {
        m_width = info.width;
        m_height = info.height;
        m_framerate = sanitizeFramerate(info.framerate);
    }

    // This code is okay though it may look strange as the return value is ignored.
    // Calling the SoftcamStream constructor results in calling the CBaseOutputPin
    // constructor which registers the instance to this Softcam instance by calling
    // CSource::AddPin().
    (void)new SoftcamStream(phr, this, L"EvCam Stream");
}


STDMETHODIMP Softcam::NonDelegatingQueryInterface(REFIID riid, __deref_out void **ppv)
{
    if (riid == IID_IAMStreamConfig)
    {
        LOG("(Softcam) IAMStreamConfig -> S_OK\n");
        return GetInterface(static_cast<IAMStreamConfig*>(this), ppv);
    }
    else
    {
        auto result = CSource::NonDelegatingQueryInterface(riid, ppv);
        LOG("(Softcam) %s -> %s\n", IID_TO_STR(riid).c_str(), result ? "(ERROR)" : "S_OK");
        return result;
    }
}

PixelFormat
Softcam::formatAt(int position) const
{
    const PixelFormat current = currentFormat();
    if (position <= 0)
    {
        return current;
    }
    int n = 0;
    for (int f = 0; f < PF_COUNT; f++)
    {
        if (f != current && ++n == position)
        {
            return (PixelFormat)f;
        }
    }
    return current;
}

HRESULT
Softcam::SetFormat(AM_MEDIA_TYPE *mt)
{
    if (!mt)
    {
        LOG("-> E_POINTER\n");
        return E_POINTER;
    }
    PixelFormat fmt;
    if (!parseMediaType(mt, m_width, m_height, &fmt))
    {
        LOG("-> VFW_E_INVALIDMEDIATYPE\n");
        return VFW_E_INVALIDMEDIATYPE;
    }
    const PixelFormat previous = currentFormat();
    if (fmt == previous)
    {
        return S_OK;
    }
    setCurrentFormat(fmt);

    // If the pin is already connected, the new format only takes effect after a
    // reconnection, which is only possible while the graph is stopped.
    CBasePin* pin = (m_iPins > 0) ? m_paStreams[0] : nullptr;
    if (pin && pin->IsConnected())
    {
        if (!IsStopped())
        {
            setCurrentFormat(previous);
            return VFW_E_NOT_STOPPED;
        }
        if (m_pGraph)
        {
            HRESULT hr = m_pGraph->Reconnect(pin);
            if (FAILED(hr))
            {
                setCurrentFormat(previous);
                m_pGraph->Reconnect(pin);
                return hr;
            }
        }
    }
    LOG("-> S_OK\n");
    return S_OK;
}

HRESULT
Softcam::GetFormat(AM_MEDIA_TYPE **out_pmt)
{
    if (!out_pmt)
    {
        LOG("-> E_POINTER\n");
        return E_POINTER;
    }
    AM_MEDIA_TYPE* mt = makeMediaType(currentFormat(), m_width, m_height, m_framerate);
    if (!mt)
    {
        LOG("-> E_OUTOFMEMORY\n");
        return E_OUTOFMEMORY;
    }
    *out_pmt = mt;
    LOG("-> S_OK\n");
    return S_OK;
}

HRESULT
Softcam::GetNumberOfCapabilities(int *out_count, int *out_size)
{
    if (!out_count || !out_size)
    {
        LOG("-> E_POINTER\n");
        return E_POINTER;
    }
    *out_count = PF_COUNT;
    *out_size = sizeof(VIDEO_STREAM_CONFIG_CAPS);
    LOG("-> S_OK\n");
    return S_OK;
}

HRESULT
Softcam::GetStreamCaps(int index, AM_MEDIA_TYPE **out_pmt, BYTE *out_scc)
{
    if (!out_pmt || !out_scc)
    {
        LOG("-> E_POINTER\n");
        return E_POINTER;
    }
    if (index < 0)
    {
        LOG("-> E_INVALIDARG\n");
        return E_INVALIDARG;
    }
    if (index >= PF_COUNT)
    {
        LOG("-> S_FALSE (invalid index)\n");
        return S_FALSE;
    }
    // One entry per format, always in the default order (YUY2, NV12, I420, RGB24),
    // with a fixed size and frame rate (min == max).
    AM_MEDIA_TYPE *mt = makeMediaType((PixelFormat)index, m_width, m_height, m_framerate);
    if (!mt)
    {
        LOG("-> E_OUTOFMEMORY\n");
        return E_OUTOFMEMORY;
    }
    *out_pmt = mt;
    std::memset(out_scc, 0, sizeof(VIDEO_STREAM_CONFIG_CAPS));
    VIDEOINFOHEADER* format = (VIDEOINFOHEADER*)mt->pbFormat;
    VIDEO_STREAM_CONFIG_CAPS* scc = (VIDEO_STREAM_CONFIG_CAPS*)out_scc;
    scc->guid = FORMAT_VideoInfo;
    scc->InputSize = SIZE{m_width, m_height};
    scc->MinCroppingSize = SIZE{m_width, m_height};
    scc->MaxCroppingSize = SIZE{m_width, m_height};
    scc->CropGranularityX = 1;
    scc->CropGranularityY = 1;
    scc->CropAlignX = 1;
    scc->CropAlignY = 1;
    scc->MinOutputSize = SIZE{m_width, m_height};
    scc->MaxOutputSize = SIZE{m_width, m_height};
    scc->OutputGranularityX = 1;
    scc->OutputGranularityY = 1;
    scc->StretchTapsX = 0;
    scc->StretchTapsY = 0;
    scc->ShrinkTapsX = 0;
    scc->ShrinkTapsY = 0;
    scc->MinFrameInterval = format->AvgTimePerFrame;
    scc->MaxFrameInterval = format->AvgTimePerFrame;
    scc->MinBitsPerSecond = (LONG)format->dwBitRate;
    scc->MaxBitsPerSecond = (LONG)format->dwBitRate;
    LOG("-> S_OK\n");
    return S_OK;
}


FrameBuffer* Softcam::getFrameBuffer()
{
    CAutoLock lock(&m_critsec);
    if (m_frame_buffer)
    {
        return &m_frame_buffer;
    }

    // No sender connected yet (or it went away): look for a new one, at most every
    // 100 ms. Merely probing has no side effect on the sender. To avoid latching
    // onto the leftovers of a crashed sender (whose shared memory may still be held
    // by another host), we only open it once its heartbeat has been seen moving
    // between two probes.
    const ULONGLONG now = GetTickCount64();
    if (m_last_open_try != 0 && now - m_last_open_try < 100)
    {
        return nullptr;
    }
    m_last_open_try = now;

    FrameBuffer::Info info;
    if (!FrameBuffer::peek(&info) || !info.active)
    {
        m_candidate_heartbeat = -1;
        return nullptr;
    }
    if (m_candidate_heartbeat < 0 || m_candidate_heartbeat == (int)info.sender_heartbeat)
    {
        m_candidate_heartbeat = (int)info.sender_heartbeat;
        return nullptr;
    }
    m_candidate_heartbeat = -1;

    auto fb = FrameBuffer::open();
    if (fb && fb.active())
    {
        m_frame_buffer = fb;
        return &m_frame_buffer;
    }
    return nullptr;
}

void
Softcam::releaseFrameBuffer()
{
    CAutoLock lock(&m_critsec);
    m_frame_buffer.release();
    m_candidate_heartbeat = -1;
}

SoftcamStream::SoftcamStream(HRESULT *phr,
                         Softcam *pParent,
                         LPCWSTR pPinName) :
    CSourceStream(NAME("EvCam Stream"), phr, pParent, pPinName),
    m_out_w(pParent->width()),
    m_out_h(pParent->height())
{
    m_fmt = pParent->currentFormat();
    m_sample_size = (long)outputImageSize(m_fmt, m_out_w, m_out_h);
    m_frame_duration = frameDurationOf(pParent->framerate());
}


SoftcamStream::~SoftcamStream()
{
    LOG("===== logging finished =====\n");
    CLOSE_LOGFILE();
}


STDMETHODIMP SoftcamStream::NonDelegatingQueryInterface(REFIID riid, __deref_out void **ppv)
{
    if (riid == IID_IKsPropertySet )
    {
        LOG("(SoftcamStream) IKsPropertySet -> S_OK\n");
        return GetInterface(static_cast<IKsPropertySet*>(this), ppv);
    }
    else if(riid == IID_IAMStreamConfig)
    {
        LOG("(SoftcamStream) IAMStreamConfig -> S_OK\n");
        return GetInterface(static_cast<IAMStreamConfig*>(this), ppv);
    }
    else
    {
        auto result = CSourceStream::NonDelegatingQueryInterface(riid, ppv);
        LOG("(SoftcamStream) %s -> %s\n", IID_TO_STR(riid).c_str(), result ? "(ERROR)" : "S_OK");
        return result;
    }
}


bool SoftcamStream::ensureIdleBuffer()
{
    return m_idle || allocateBuffer(m_idle, (std::size_t)m_sample_size);
}

void SoftcamStream::ensureIdle()
{
    if (m_idle_ready)
    {
        return;
    }
    // Placeholder: drawn once at the output size and converted to the output format.
    std::unique_ptr<uint8_t[]> bgr;
    if (!ensureIdleBuffer() || !allocateBuffer(bgr, (std::size_t)m_out_w * m_out_h * 3))
    {
        return;
    }
    fillPlaceholderBGR(bgr.get(), m_out_w, m_out_h);
    m_converter.convert(bgr.get(), m_out_w, m_out_h, m_fmt, m_idle.get(), m_out_w, m_out_h);
    m_idle_ready = true;
}

void SoftcamStream::buildIdleFromSource()
{
    // The sender is gone: keep its last image, darkened to show that the source is
    // inactive, as the idle picture.
    if (!m_has_src || !m_src || !ensureIdleBuffer())
    {
        return;
    }
    darkenBGR(m_src.get(), (std::size_t)m_src_w * m_src_h * 3);
    m_converter.convert(m_src.get(), m_src_w, m_src_h, m_fmt, m_idle.get(), m_out_w, m_out_h);
    m_idle_ready = true;
}

HRESULT SoftcamStream::FillBuffer(IMediaSample *pms)
{
    CheckPointer(pms,E_POINTER);

    BYTE *pData = nullptr;
    if (FAILED(pms->GetPointer(&pData)) || !pData ||
        m_sample_size <= 0 || pms->GetSize() < m_sample_size)
    {
        LOG("-> E_FAIL (no usable buffer)\n");
        return E_FAIL;
    }

    // Never deliver faster than the frame rate: a faster sender is decimated, and
    // while there is no sender the placeholder runs at exactly this rate.
    sleepUntil(m_next_slot);

    bool live = false;
    FrameBuffer* fb = getParent()->getFrameBuffer();
    if (fb && !m_receiving)
    {
        // A sender has (re)appeared; its size can differ from the output size and
        // from the previous sender's.
        const int sw = fb->width();
        const int sh = fb->height();
        const std::size_t need = (std::size_t)sw * sh * 3;
        if (sw > 0 && sh > 0 && (m_src_capacity >= need || allocateBuffer(m_src, need)))
        {
            m_src_capacity = (std::max)(m_src_capacity, need);
            m_src_w = sw;
            m_src_h = sh;
            m_frame_counter = 0;
            m_has_src = false;
            m_receiving = true;
        }
        else
        {
            m_src_capacity = 0;
            getParent()->releaseFrameBuffer();
            fb = nullptr;
        }
    }
    if (fb)
    {
        const bool alive = fb->waitForNewFrame(m_frame_counter, m_wait_timeout);
        if (fb->frameCounter() != m_frame_counter)
        {
            if (fb->copyImage(m_src.get(), m_src_capacity, &m_frame_counter))
            {
                m_has_src = (m_frame_counter > 0);
            }
        }
        if (alive)
        {
            live = m_has_src;
        }
        else
        {
            // The sender has deactivated this stream or stopped sending frames.
            // We release it (so that a new sender can be created) and wait for the
            // next one while showing the dimmed last image.
            getParent()->releaseFrameBuffer();
            m_receiving = false;
            buildIdleFromSource();
            m_has_src = false;
        }
    }
    else if (m_receiving)
    {
        m_receiving = false;
    }

    if (live)
    {
        m_converter.convert(m_src.get(), m_src_w, m_src_h, m_fmt, pData, m_out_w, m_out_h);
    }
    else
    {
        ensureIdle();
        if (!m_idle_ready)
        {
            return E_OUTOFMEMORY;
        }
        std::memcpy(pData, m_idle.get(), (std::size_t)m_sample_size);
    }

    // Time stamps follow the real time since the stream started.
    const long long now = qpcNow();
    REFERENCE_TIME start = ticksToRefTime(now - m_stream_t0);
    if (start <= m_last_start)
    {
        start = m_last_start + 1;
    }
    m_last_start = start;
    REFERENCE_TIME end = start + m_frame_duration;
    pms->SetTime(&start, &end);
    pms->SetSyncPoint(TRUE);
    pms->SetPreroll(FALSE);
    pms->SetDiscontinuity(m_first_sample ? TRUE : FALSE);
    pms->SetActualDataLength(m_sample_size);
    m_first_sample = false;

    // Next slot: one frame period after this one; if we are already late, now.
    m_next_slot = (std::max)(m_next_slot + refTimeToTicks(m_frame_duration), now);
    //LOG("-> NOERROR\n");
    return NOERROR;
}


STDMETHODIMP SoftcamStream::Notify(IBaseFilter * pSender, Quality q)
{
    // Quality control is not used: the frame rate is fixed by the sender.
    return NOERROR;
}


HRESULT SoftcamStream::CheckMediaType(const CMediaType *pmt)
{
    CheckPointer(pmt, E_POINTER);
    Softcam* parent = getParent();
    PixelFormat fmt;
    if (!parseMediaType(pmt, parent->width(), parent->height(), &fmt))
    {
        LOG("-> VFW_E_TYPE_NOT_ACCEPTED\n");
        return VFW_E_TYPE_NOT_ACCEPTED;
    }
    return S_OK;
}

HRESULT SoftcamStream::SetMediaType(const CMediaType *pmt)
{
    CheckPointer(pmt, E_POINTER);
    HRESULT hr = CSourceStream::SetMediaType(pmt);
    if (FAILED(hr))
    {
        return hr;
    }
    Softcam* parent = getParent();
    PixelFormat fmt;
    REFERENCE_TIME duration = 0;
    if (parseMediaType(pmt, parent->width(), parent->height(), &fmt, &duration))
    {
        m_fmt = fmt;
        m_out_w = parent->width();
        m_out_h = parent->height();
        m_sample_size = (long)outputImageSize(fmt, m_out_w, m_out_h);
        // Honour the frame rate the host asked for if it is sensible.
        if (duration < 41666 || duration > 10000000)    // faster than 240 fps or slower than 1 fps
        {
            duration = frameDurationOf(parent->framerate());
        }
        m_frame_duration = duration;
        parent->setCurrentFormat(fmt);
    }
    LOG("-> %d\n", (int)m_fmt);
    return hr;
}

HRESULT SoftcamStream::GetMediaType(CMediaType *pmt)
{
    return GetMediaType(0, pmt);
}

HRESULT SoftcamStream::GetMediaType(int iPosition, CMediaType *pmt)
{
    CheckPointer(pmt,E_POINTER);

    if (iPosition < 0)
    {
        return E_INVALIDARG;
    }
    if (iPosition >= PF_COUNT)
    {
        return VFW_S_NO_MORE_ITEMS;
    }

    // Position 0 is the format selected with SetFormat (or negotiated last), by default
    // YUY2; then the remaining formats in order of preference: NV12, I420, RGB24.
    Softcam* parent = getParent();
    VIDEOINFOHEADER *pvi = (VIDEOINFOHEADER*)pmt->AllocFormatBuffer(sizeof(VIDEOINFOHEADER));
    if (pvi == nullptr)
    {
        LOG("-> E_OUTOFMEMORY\n");
        return E_OUTOFMEMORY;
    }

    fillMediaType(pmt, parent->formatAt(iPosition), parent->width(), parent->height(), parent->framerate());

    LOG("-> NOERROR\n");
    return NOERROR;
}

HRESULT SoftcamStream::DecideBufferSize(IMemAllocator *pAlloc,
                                        ALLOCATOR_PROPERTIES *pProperties)
{
    CheckPointer(pAlloc,E_POINTER);
    CheckPointer(pProperties,E_POINTER);

    CAutoLock lock(m_pFilter->pStateLock());
    HRESULT hr = NOERROR;

    // Size of one image in the negotiated format.
    if (m_sample_size <= 0)
    {
        return E_UNEXPECTED;
    }
    if (pProperties->cBuffers < 2)
    {
        pProperties->cBuffers = 2;
    }
    if (pProperties->cbBuffer < m_sample_size)
    {
        pProperties->cbBuffer = m_sample_size;
    }
    if (pProperties->cbAlign <= 0)
    {
        pProperties->cbAlign = 1;
    }

    ALLOCATOR_PROPERTIES actual;
    hr = pAlloc->SetProperties(pProperties, &actual);
    if (FAILED(hr))
    {
        LOG("-> (FAILED)\n");
        return hr;
    }
    if (actual.cbBuffer < m_sample_size)
    {
        LOG("-> E_FAIL\n");
        return E_FAIL;
    }
    LOG("-> NOERROR\n");
    return NOERROR;
}

HRESULT SoftcamStream::OnThreadCreate()
{
    // Start from a clean state: no sender, nothing cached, time zero.
    getParent()->releaseFrameBuffer();
    m_frame_counter = 0;
    m_receiving = false;
    m_has_src = false;
    m_idle_ready = false;
    m_idle.reset();
    m_first_sample = true;
    m_last_start = -1;
    m_stream_t0 = qpcNow();
    m_next_slot = m_stream_t0;

    // Wait up to 1.5 frame periods for a new sender frame before repeating the last
    // one, so that hosts keep receiving frames at the nominal rate even if the sender
    // stalls.
    const float period = (float)((double)m_frame_duration / 10000000.0);
    m_wait_timeout = (std::min)((std::max)(period * 1.5f, 0.02f), 0.5f);

    LOG("-> NOERROR\n");
    return NOERROR;
}

HRESULT SoftcamStream::OnThreadDestroy()
{
    // Let go of the shared memory as soon as the stream stops, so that a sender can
    // be restarted even though this host app stays open.
    getParent()->releaseFrameBuffer();
    m_receiving = false;
    m_has_src = false;
    m_src.reset();
    m_src_capacity = 0;
    m_idle.reset();
    m_idle_ready = false;
    return NOERROR;
}

HRESULT SoftcamStream::Set(REFGUID guidPropSet, DWORD dwPropID,
                           LPVOID pInstanceData, DWORD cbInstanceData,
                           LPVOID pPropData, DWORD cbPropData)
{
    LOG("-> E_NOTIMPL\n");
    return E_NOTIMPL;
}

HRESULT SoftcamStream::Get(REFGUID guidPropSet, DWORD dwPropID,
                           LPVOID pInstanceData, DWORD cbInstanceData,
                           LPVOID pPropData, DWORD cbPropData, DWORD *pcbReturned)
{
    if (guidPropSet != AMPROPSETID_Pin)
    {
        LOG("-> E_PROP_SET_UNSUPPORTED\n");
        return E_PROP_SET_UNSUPPORTED;
    }
    if (dwPropID != AMPROPERTY_PIN_CATEGORY)
    {
        LOG("-> E_PROP_ID_UNSUPPORTED\n");
        return E_PROP_ID_UNSUPPORTED;
    }
    if (pPropData == nullptr && pcbReturned == nullptr)
    {
        LOG("-> E_POINTER\n");
        return E_POINTER;
    }
    if (pcbReturned)
    {
        *pcbReturned = sizeof(GUID);
    }
    if (pPropData)
    {
        if (cbPropData < sizeof(GUID))
        {
            LOG("-> E_UNEXPECTED\n");
            return E_UNEXPECTED;
        }
        *(GUID*)pPropData = PIN_CATEGORY_CAPTURE;
    }
    LOG("-> S_OK\n");
    return S_OK;
}

HRESULT SoftcamStream::QuerySupported(REFGUID guidPropSet, DWORD dwPropID,
                              DWORD *pTypeSupport)
{
    if (guidPropSet != AMPROPSETID_Pin)
    {
        LOG("-> E_PROP_SET_UNSUPPORTED\n");
        return E_PROP_SET_UNSUPPORTED;
    }
    if (dwPropID != AMPROPERTY_PIN_CATEGORY)
    {
        LOG("-> E_PROP_ID_UNSUPPORTED\n");
        return E_PROP_ID_UNSUPPORTED;
    }
    if (pTypeSupport)
    {
        *pTypeSupport = KSPROPERTY_SUPPORT_GET;
    }
    LOG("-> S_OK\n");
    return S_OK;
}

HRESULT SoftcamStream::SetFormat(AM_MEDIA_TYPE *mt)
{
    return getParent()->SetFormat(mt);
}

HRESULT SoftcamStream::GetFormat(AM_MEDIA_TYPE **out_pmt)
{
    return getParent()->GetFormat(out_pmt);
}

HRESULT SoftcamStream::GetNumberOfCapabilities(int *out_count, int *out_size)
{
    return getParent()->GetNumberOfCapabilities(out_count, out_size);
}

HRESULT SoftcamStream::GetStreamCaps(int index, AM_MEDIA_TYPE **out_pmt, BYTE *out_scc)
{
    return getParent()->GetStreamCaps(index, out_pmt, out_scc);
}

Softcam* SoftcamStream::getParent()
{
    return static_cast<Softcam*>(m_pFilter);
}


} //namespace softcam
