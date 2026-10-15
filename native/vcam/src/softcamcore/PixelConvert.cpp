#include "PixelConvert.h"

#include <cstring>


namespace softcam {

namespace {

// BT.601 limited range, 8-bit fixed point (the classic integer approximation):
//   Y =  16 + (( 66 R + 129 G +  25 B + 128) >> 8)     -> 16..235
//   U = 128 + ((-38 R -  74 G + 112 B + 128) >> 8)     -> 16..240
//   V = 128 + ((112 R -  94 G -  18 B + 128) >> 8)     -> 16..240
// Chroma is computed from the sum of 2 (YUY2) or 4 (4:2:0) source pixels, so the
// shift grows by 1 or 2 bits. All results stay within range without clamping.

inline int lumaOf(int r, int g, int b)
{
    return 16 + ((66 * r + 129 * g + 25 * b + 128) >> 8);
}

template <int SHIFT>
inline int chromaU(int r, int g, int b)    // r, g, b: sums of 2^(SHIFT-8) samples
{
    return 128 + ((-38 * r - 74 * g + 112 * b + (1 << (SHIFT - 1))) >> SHIFT);
}

template <int SHIFT>
inline int chromaV(int r, int g, int b)
{
    return 128 + ((112 * r - 94 * g - 18 * b + (1 << (SHIFT - 1))) >> SHIFT);
}

struct Job
{
    const std::uint8_t*     src;    // source image, top-down BGR24
    std::uint8_t*           dst;
    int                     dw, dh;
    const std::uint32_t*    xoff;   // per destination column: source byte offset
    const std::size_t*      yoff;   // per destination row: source byte offset
};

// Returns a pointer to the source pixel feeding destination column dx of a row.
template <bool Scaled>
inline const std::uint8_t* pixelAt(const std::uint8_t* row, const Job& j, int dx)
{
    return Scaled ? row + j.xoff[dx] : row + 3 * (std::size_t)dx;
}

template <bool Scaled>
void toYUY2(const Job& j)
{
    for (int y = 0; y < j.dh; y++)
    {
        const std::uint8_t* row = j.src + j.yoff[y];
        std::uint8_t* d = j.dst + (std::size_t)y * j.dw * 2;
        for (int x = 0; x < j.dw; x += 2, d += 4)
        {
            const std::uint8_t* p0 = pixelAt<Scaled>(row, j, x);
            const std::uint8_t* p1 = pixelAt<Scaled>(row, j, x + 1);
            const int b0 = p0[0], g0 = p0[1], r0 = p0[2];
            const int b1 = p1[0], g1 = p1[1], r1 = p1[2];
            const int rs = r0 + r1, gs = g0 + g1, bs = b0 + b1;
            d[0] = (std::uint8_t)lumaOf(r0, g0, b0);
            d[1] = (std::uint8_t)chromaU<9>(rs, gs, bs);
            d[2] = (std::uint8_t)lumaOf(r1, g1, b1);
            d[3] = (std::uint8_t)chromaV<9>(rs, gs, bs);
        }
    }
}

// 4:2:0 output. Planar selects I420 (separate U and V planes) over NV12 (UV pairs).
template <bool Scaled, bool Planar>
void to420(const Job& j)
{
    const int cw = j.dw / 2;
    std::uint8_t* yplane = j.dst;
    std::uint8_t* cbase = j.dst + (std::size_t)j.dw * j.dh;
    std::uint8_t* uplane = cbase;
    std::uint8_t* vplane = cbase + (std::size_t)cw * (j.dh / 2);

    for (int y = 0; y < j.dh; y += 2)
    {
        const std::uint8_t* rowA = j.src + j.yoff[y];
        const std::uint8_t* rowB = j.src + j.yoff[y + 1];
        std::uint8_t* ya = yplane + (std::size_t)y * j.dw;
        std::uint8_t* yb = ya + j.dw;
        std::uint8_t* uv = cbase + (std::size_t)(y / 2) * j.dw;                 // NV12 chroma row
        std::uint8_t* u = uplane + (std::size_t)(y / 2) * cw;                   // I420 chroma rows
        std::uint8_t* v = vplane + (std::size_t)(y / 2) * cw;
        for (int x = 0; x < j.dw; x += 2)
        {
            const std::uint8_t* a0 = pixelAt<Scaled>(rowA, j, x);
            const std::uint8_t* a1 = pixelAt<Scaled>(rowA, j, x + 1);
            const std::uint8_t* b0 = pixelAt<Scaled>(rowB, j, x);
            const std::uint8_t* b1 = pixelAt<Scaled>(rowB, j, x + 1);
            ya[x]     = (std::uint8_t)lumaOf(a0[2], a0[1], a0[0]);
            ya[x + 1] = (std::uint8_t)lumaOf(a1[2], a1[1], a1[0]);
            yb[x]     = (std::uint8_t)lumaOf(b0[2], b0[1], b0[0]);
            yb[x + 1] = (std::uint8_t)lumaOf(b1[2], b1[1], b1[0]);
            const int rs = a0[2] + a1[2] + b0[2] + b1[2];
            const int gs = a0[1] + a1[1] + b0[1] + b1[1];
            const int bs = a0[0] + a1[0] + b0[0] + b1[0];
            const std::uint8_t cu = (std::uint8_t)chromaU<10>(rs, gs, bs);
            const std::uint8_t cv = (std::uint8_t)chromaV<10>(rs, gs, bs);
            if (Planar)
            {
                u[x >> 1] = cu;
                v[x >> 1] = cv;
            }
            else
            {
                uv[x]     = cu;
                uv[x + 1] = cv;
            }
        }
    }
}

// 24-bit DIB: bottom-up rows padded to a multiple of 4 bytes.
template <bool Scaled>
void toRGB24(const Job& j)
{
    const std::size_t rowbytes = 3 * (std::size_t)j.dw;
    const std::size_t stride = (rowbytes + 3) & ~(std::size_t)3;
    for (int m = 0; m < j.dh; m++)
    {
        const std::uint8_t* row = j.src + j.yoff[j.dh - 1 - m];
        std::uint8_t* d = j.dst + (std::size_t)m * stride;
        if (Scaled)
        {
            for (int x = 0; x < j.dw; x++, d += 3)
            {
                const std::uint8_t* p = row + j.xoff[x];
                d[0] = p[0];
                d[1] = p[1];
                d[2] = p[2];
            }
        }
        else
        {
            std::memcpy(d, row, rowbytes);
            d += rowbytes;
        }
        for (std::size_t k = rowbytes; k < stride; k++)
        {
            *d++ = 0;
        }
    }
}

} //namespace


std::size_t outputImageSize(PixelFormat fmt, int width, int height)
{
    const std::size_t w = (std::size_t)width, h = (std::size_t)height;
    switch (fmt)
    {
    case PF_YUY2:   return w * h * 2;
    case PF_NV12:
    case PF_I420:   return w * h * 3 / 2;
    case PF_RGB24:  return ((w * 3 + 3) & ~(std::size_t)3) * h;
    default:        return 0;
    }
}


void PixelConverter::prepare(int sw, int sh, int dw, int dh)
{
    if (sw == m_sw && sh == m_sh && dw == m_dw && dh == m_dh)
    {
        return;
    }
    m_sw = sw; m_sh = sh; m_dw = dw; m_dh = dh;
    m_xoff.resize((std::size_t)dw);
    m_yoff.resize((std::size_t)dh);
    // Pixel-centre mapping: dst pixel d samples the source pixel containing the
    // centre of d. Identity when the sizes match. The (few) divisions happen here,
    // once per size change, never per pixel.
    for (int x = 0; x < dw; x++)
    {
        std::int64_t sx = ((std::int64_t)(2 * x + 1) * sw) / (2 * (std::int64_t)dw);
        if (sx >= sw) sx = sw - 1;
        m_xoff[(std::size_t)x] = (std::uint32_t)(sx * 3);
    }
    for (int y = 0; y < dh; y++)
    {
        std::int64_t sy = ((std::int64_t)(2 * y + 1) * sh) / (2 * (std::int64_t)dh);
        if (sy >= sh) sy = sh - 1;
        m_yoff[(std::size_t)y] = (std::size_t)sy * 3 * (std::size_t)sw;
    }
}

void PixelConverter::convert(const std::uint8_t* src, int sw, int sh,
                             PixelFormat fmt,
                             std::uint8_t* dst, int dw, int dh)
{
    if (!src || !dst || sw < 1 || sh < 1 || dw < 2 || dh < 2)
    {
        return;
    }
    prepare(sw, sh, dw, dh);
    Job j{ src, dst, dw, dh, m_xoff.data(), m_yoff.data() };
    const bool scaled = (sw != dw);
    switch (fmt)
    {
    case PF_YUY2:   scaled ? toYUY2<true>(j)        : toYUY2<false>(j);         break;
    case PF_NV12:   scaled ? to420<true, false>(j)  : to420<false, false>(j);   break;
    case PF_I420:   scaled ? to420<true, true>(j)   : to420<false, true>(j);    break;
    case PF_RGB24:  scaled ? toRGB24<true>(j)       : toRGB24<false>(j);        break;
    default: break;
    }
}


void fillPlaceholderBGR(std::uint8_t* bgr, int w, int h)
{
    if (!bgr || w < 1 || h < 1)
    {
        return;
    }
    const int m = w < h ? w : h;
    const int cx = w / 2, cy = h / 2;
    const int r_out = m * 22 / 100;                             // outer radius of the ring
    const int thick = (m / 40) < 2 ? 2 : (m / 40);
    const int r_in = r_out - thick;                             // inner radius of the ring
    const int r_lens = r_in * 62 / 100;                         // inner "lens" disc
    const int hx = cx - r_lens * 35 / 100, hy = cy - r_lens * 35 / 100;
    const int r_hl = r_lens * 22 / 100;                         // specular highlight
    const int out2 = r_out * r_out, in2 = r_in * r_in;
    const int lens2 = r_lens * r_lens, hl2 = r_hl * r_hl;

    for (int y = 0; y < h; y++)
    {
        // Vertical gradient, dark navy to deeper blue.
        const int t = h > 1 ? y * 255 / (h - 1) : 0;
        const std::uint8_t gr = (std::uint8_t)(10 + t * 12 / 255);
        const std::uint8_t gg = (std::uint8_t)(18 + t * 26 / 255);
        const std::uint8_t gb = (std::uint8_t)(48 + t * 52 / 255);
        std::uint8_t* d = bgr + (std::size_t)y * w * 3;
        const int dy = y - cy;
        const bool inBand = (dy >= -r_out && dy <= r_out);
        const int dy2 = dy * dy;
        for (int x = 0; x < w; x++, d += 3)
        {
            std::uint8_t r = gr, g = gg, b = gb;
            if (inBand)
            {
                const int dx = x - cx;
                const int d2 = dx * dx + dy2;
                if (d2 <= out2)
                {
                    if (d2 >= in2)
                    {
                        r = 190; g = 210; b = 235;              // ring
                    }
                    else if (d2 <= lens2)
                    {
                        const int hx_ = x - hx, hy_ = y - hy;
                        if (hx_ * hx_ + hy_ * hy_ <= hl2)
                        {
                            r = 150; g = 185; b = 235;          // highlight
                        }
                        else
                        {
                            r = 26; g = 44; b = 104;            // lens
                        }
                    }
                }
            }
            d[0] = b;
            d[1] = g;
            d[2] = r;
        }
    }
}

void darkenBGR(std::uint8_t* bgr, std::size_t bytes)
{
    std::size_t i = 0;
    for (; i + 8 <= bytes; i += 8)
    {
        std::uint64_t v;
        std::memcpy(&v, bgr + i, 8);
        v = (v >> 2) & 0x3F3F3F3F3F3F3F3FULL;
        std::memcpy(bgr + i, &v, 8);
    }
    for (; i < bytes; i++)
    {
        bgr[i] = (std::uint8_t)(bgr[i] >> 2);
    }
}


} //namespace softcam
