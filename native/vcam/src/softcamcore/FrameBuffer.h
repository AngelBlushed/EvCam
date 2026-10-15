#pragma once

#include <cstdint>
#include <cstddef>
#include "Misc.h"
#include "Watchdog.h"


namespace softcam {


using std::uint64_t;
using std::uint32_t;
using std::uint16_t;


/// Shared frame buffer between processes (sender and receiver)
class FrameBuffer
{
 public:
    /// An empty (closed) frame buffer.
    FrameBuffer();

    static FrameBuffer create(
                        int             width,
                        int             height,
                        float           framerate = 0.0f);
    static FrameBuffer open();

    /// Snapshot of the sender's header. Obtained without any side effect on the
    /// sender (no heartbeat thread, no "connected" flag), so it is safe to call
    /// from any app that merely enumerates the camera.
    struct Info
    {
        int         width;
        int         height;
        float       framerate;
        bool        active;
        unsigned    sender_heartbeat;   // changes every ~20 ms while the sender lives
    };
    static bool peek(Info* out);

    static bool checkDimensions(
                        int width,
                        int height);

    FrameBuffer& operator =(const FrameBuffer&);
    explicit operator bool() const { return handle() != nullptr; }

    void*           handle() const;
    int             width() const;
    int             height() const;
    float           framerate() const;
    uint64_t        frameCounter() const;
    bool            active() const;
    bool            connected() const;

    void            deactivate();
    void            write(const void* image_bits);
    void            writeRGBA(const void* rgba_bits);
    void            transferToDIB(void* image_bits, uint64_t* out_frame_counter);
    /// Copies the latest image (BGR24, top-down, tightly packed) out of the shared
    /// memory while holding the lock. Returns false if `capacity` is too small.
    bool            copyImage(void* dst, std::size_t capacity, uint64_t* out_frame_counter);
    bool            waitForNewFrame(uint64_t frame_counter, float time_out = 0.5f);

    void            release();

    static constexpr float WATCHDOG_HEARTBEAT_INTERVAL = 0.02f;
    static constexpr float WATCHDOG_MONITOR_INTERVAL = 0.02f;
    static constexpr float WATCHDOG_TIMEOUT = 0.5f;

 private:
    struct Header;

    mutable NamedMutex      m_mutex;
    SharedMemory            m_shmem;
    Watchdog                m_sender_watchdog;
    Watchdog                m_receiver_watchdog;

    explicit FrameBuffer(const char* mutex_name) : m_mutex(mutex_name) {}

    Header*         header();
    const Header*   header() const;

    bool            validHeader() const;
    static uint32_t calcMemorySize(
                        uint16_t width,
                        uint16_t height);
};


} //namespace softcam
