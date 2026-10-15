#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>


namespace softcam {


/// Output pixel formats offered by the filter, in order of preference.
enum PixelFormat
{
    PF_YUY2  = 0,   // packed 4:2:2, Y0 U Y1 V
    PF_NV12  = 1,   // planar Y + interleaved UV 4:2:0
    PF_I420  = 2,   // planar Y, U, V 4:2:0
    PF_RGB24 = 3,   // 24-bit BGR DIB (bottom-up, rows padded to 4 bytes)
    PF_COUNT = 4
};

/// Size in bytes of one output image of the given format.
std::size_t outputImageSize(PixelFormat fmt, int width, int height);

/// Converts the sender's image (BGR24, top-down, tightly packed) to an output
/// format. YUV output is BT.601 limited range (what WebRTC, ffmpeg and most
/// DirectShow hosts assume). When the source and destination sizes differ the
/// image is scaled with nearest-neighbour sampling, so any source size can feed
/// any (even) output size. Fixed-point maths, no per-pixel division.
class PixelConverter
{
 public:
    /// `dst` must hold outputImageSize(fmt, dw, dh) bytes; dw and dh must be even.
    void convert(const std::uint8_t* src, int sw, int sh,
                 PixelFormat fmt,
                 std::uint8_t* dst, int dw, int dh);

 private:
    int                         m_sw = 0, m_sh = 0, m_dw = 0, m_dh = 0;
    std::vector<std::uint32_t>  m_xoff;     // source byte offset of each destination column
    std::vector<std::size_t>    m_yoff;     // source byte offset of each destination row

    void prepare(int sw, int sh, int dw, int dh);
};

/// Draws the "no sender" image (dark blue gradient with a lens ring) into a
/// top-down BGR24 buffer of w*h*3 bytes.
void fillPlaceholderBGR(std::uint8_t* bgr, int w, int h);

/// Divides every byte by four (used to dim the last frame of a lost sender).
void darkenBGR(std::uint8_t* bgr, std::size_t bytes);


} //namespace softcam
