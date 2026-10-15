#pragma once

#include <atomic>
#include <memory>
#include <baseclasses/streams.h>
#include "FrameBuffer.h"
#include "PixelConvert.h"


namespace softcam {


class SoftcamStream;

class Softcam : public CSource, public IAMStreamConfig
{
public:
    static CUnknown* CreateInstance(
                    LPUNKNOWN   lpunk,
                    const GUID& clsid,
                    HRESULT*    phr);

    // IUnknown Methods
    DECLARE_IUNKNOWN
    STDMETHODIMP NonDelegatingQueryInterface(REFIID riid, __deref_out void **ppv) override;

    // IAMStreamConfig
    HRESULT STDMETHODCALLTYPE SetFormat(AM_MEDIA_TYPE *mt) override;
    HRESULT STDMETHODCALLTYPE GetFormat(AM_MEDIA_TYPE **out_pmt) override;
    HRESULT STDMETHODCALLTYPE GetNumberOfCapabilities(int *out_count, int *out_size) override;
    HRESULT STDMETHODCALLTYPE GetStreamCaps(int index, AM_MEDIA_TYPE **out_pmt, BYTE *out_scc) override;

    /// The sender's frame buffer, (re)opened on demand while a live sender exists.
    /// Returns null if there is no sender (yet). Called from the stream thread only.
    FrameBuffer*    getFrameBuffer();
    void            releaseFrameBuffer();

    /// Size and rate advertised by this filter instance: the sender's if one existed
    /// when the filter was created, otherwise 1280x720 @ 30 fps. Fixed for its lifetime.
    int             width() const { return m_width; }
    int             height() const { return m_height; }
    float           framerate() const { return m_framerate; }

    /// Format preferred for the next connection (SetFormat) or negotiated last.
    PixelFormat     currentFormat() const { return (PixelFormat)m_format.load(); }
    void            setCurrentFormat(PixelFormat fmt) { m_format = (int)fmt; }
    /// Format listed at `position` of the pin's media type enumeration
    /// (the current format first, then the others in default order).
    PixelFormat     formatAt(int position) const;

private:
    CCritSec            m_critsec;
    FrameBuffer         m_frame_buffer;
    int                 m_width;
    int                 m_height;
    float               m_framerate;
    std::atomic<int>    m_format;
    ULONGLONG           m_last_open_try = 0;        // GetTickCount64() of the last probe
    int                 m_candidate_heartbeat = -1; // sender heartbeat seen by the last probe

    Softcam(LPUNKNOWN lpunk, const GUID& clsid, HRESULT *phr);
};


class SoftcamStream : public CSourceStream, public IKsPropertySet, public IAMStreamConfig
{
 public:
    SoftcamStream(HRESULT *phr, Softcam *pParent, LPCWSTR pPinName);
    ~SoftcamStream();

    // IUnknown
    DECLARE_IUNKNOWN
    STDMETHODIMP NonDelegatingQueryInterface(REFIID riid, __deref_out void **ppv) override;

    // CBasePin
    STDMETHODIMP Notify(IBaseFilter * pSender, Quality q) override;
    HRESULT CheckMediaType(const CMediaType *pMediaType) override;
    HRESULT SetMediaType(const CMediaType *pMediaType) override;

    // CBaseOutputPin
    // Ask for buffers of the size appropriate to the agreed media type
    HRESULT DecideBufferSize(IMemAllocator *pIMemAlloc,
                             ALLOCATOR_PROPERTIES *pProperties) override;

    // CSourceStream
    HRESULT FillBuffer(IMediaSample *pms) override;
    HRESULT GetMediaType(CMediaType *pMediaType) override;
    HRESULT GetMediaType(int iPosition, CMediaType *pMediaType) override;
    HRESULT OnThreadCreate(void) override;
    HRESULT OnThreadDestroy(void) override;

    //  IKsPropertySet
    HRESULT STDMETHODCALLTYPE Set(REFGUID guidPropSet, DWORD dwPropID,
                                  LPVOID pInstanceData, DWORD cbInstanceData,
                                  LPVOID pPropData, DWORD cbPropData) override;
    HRESULT STDMETHODCALLTYPE Get(REFGUID guidPropSet, DWORD dwPropID,
                                  LPVOID pInstanceData, DWORD cbInstanceData,
                                  LPVOID pPropData, DWORD cbPropData, DWORD *pcbReturned) override;
    HRESULT STDMETHODCALLTYPE QuerySupported(REFGUID guidPropSet, DWORD dwPropID,
                                             DWORD *pTypeSupport) override;

    // IAMStreamConfig
    HRESULT STDMETHODCALLTYPE SetFormat(AM_MEDIA_TYPE *mt) override;
    HRESULT STDMETHODCALLTYPE GetFormat(AM_MEDIA_TYPE **out_pmt) override;
    HRESULT STDMETHODCALLTYPE GetNumberOfCapabilities(int *out_count, int *out_size) override;
    HRESULT STDMETHODCALLTYPE GetStreamCaps(int index, AM_MEDIA_TYPE **out_pmt, BYTE *out_scc) override;

private:
    // Negotiated output (set by SetMediaType, read by the streaming thread)
    PixelFormat     m_fmt = PF_YUY2;
    int             m_out_w;
    int             m_out_h;
    long            m_sample_size = 0;
    REFERENCE_TIME  m_frame_duration = 333333;      // 100 ns units
    float           m_wait_timeout = 0.05f;         // seconds to wait for a new sender frame

    // Streaming state (worker thread only)
    PixelConverter  m_converter;
    uint64_t        m_frame_counter = 0;
    bool            m_receiving = false;            // frame buffer opened and delivering
    bool            m_has_src = false;              // m_src holds a sender image
    int             m_src_w = 0;
    int             m_src_h = 0;
    std::size_t     m_src_capacity = 0;
    std::unique_ptr<uint8_t[]>  m_src;              // last sender image, BGR24 top-down
    std::unique_ptr<uint8_t[]>  m_idle;             // placeholder / dimmed last frame, in the output format
    bool            m_idle_ready = false;
    long long       m_stream_t0 = 0;                // QPC ticks at thread start
    long long       m_next_slot = 0;                // QPC ticks: earliest time of the next delivery
    REFERENCE_TIME  m_last_start = -1;
    bool            m_first_sample = true;

    bool            ensureIdleBuffer();
    void            buildIdleFromSource();
    void            ensureIdle();
    Softcam*        getParent();
};


} //namespace softcam
