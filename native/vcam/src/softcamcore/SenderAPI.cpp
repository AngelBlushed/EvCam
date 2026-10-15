#include "SenderAPI.h"

#include <atomic>

#include "FrameBuffer.h"
#include "Misc.h"


namespace {

struct Camera
{
    softcam::FrameBuffer    m_frame_buffer;
    softcam::Timer          m_timer;
};

std::atomic<Camera*>    s_camera;

} //namespace


namespace softcam {
namespace sender {

CameraHandle    CreateCamera(int width, int height, float framerate)
{
    auto fb = FrameBuffer::create(width, height, framerate);
    if (!fb && FrameBuffer::checkDimensions(width, height) && framerate >= 0.0f)
    {
        // The shared memory of a sender that just went away stays alive as long as a
        // host app still holds it; hosts let go within a fraction of a second (they
        // notice the deactivated or silent sender). Wait for them so that restarting
        // a sender (new size, new session) works, but give up at once if the existing
        // sender is alive: only one sender may exist at a time.
        FrameBuffer::Info first;
        if (FrameBuffer::peek(&first))
        {
            for (int i = 0; i < 30 && !fb; i++)
            {
                Timer::sleep(0.06f);
                FrameBuffer::Info now;
                if (FrameBuffer::peek(&now) &&
                    now.active &&
                    now.sender_heartbeat != first.sender_heartbeat)
                {
                    break;
                }
                fb = FrameBuffer::create(width, height, framerate);
            }
        }
    }
    if (fb)
    {
        Camera* camera = new Camera{ fb, Timer() };
        Camera* expected = nullptr;
        if (s_camera.compare_exchange_strong(expected, camera))
        {
            return camera;
        }
        delete camera;
    }
    return nullptr;
}

void            DeleteCamera(CameraHandle camera)
{
    Camera* target = static_cast<Camera*>(camera);
    if (target && s_camera.compare_exchange_strong(target, nullptr))
    {
        target->m_frame_buffer.deactivate();
        delete target;
    }
}

void            SendFrame(CameraHandle camera, const void* image_bits)
{
    Camera* target = static_cast<Camera*>(camera);
    if (target && s_camera.load() == target && image_bits)
    {
        auto framerate = target->m_frame_buffer.framerate();
        auto frame_counter = target->m_frame_buffer.frameCounter();

        // To deliver frames in the regular period, we sleep here a bit
        // before we deliver the new frame if it's not the time yet.
        // If it's already the time, we deliver it immediately and
        // let the timer keep running so that if the next frame comes
        // in time the constant delivery recovers.
        // However if the delay grew too much (greater than 50 percent
        // of the period), we reset the timer to avoid continuing
        // irregular delivery.
        if (0.0f < framerate)
        {
            if (0 == frame_counter) // the first frame
            {
                target->m_timer.reset();
            }
            else
            {
                auto ref_delta = 1.0f / framerate;
                auto time = target->m_timer.get();
                if (time < ref_delta)
                {
                    Timer::sleep(ref_delta - time);
                }
                if (time < ref_delta * 1.5f)
                {
                    target->m_timer.rewind(ref_delta);
                }
                else
                {
                    target->m_timer.reset();
                }
            }
        }

        target->m_frame_buffer.write(image_bits);
    }
}

void            SendFrameRGBA(CameraHandle camera, const void* rgba_bits)
{
    Camera* target = static_cast<Camera*>(camera);
    if (target && s_camera.load() == target && rgba_bits)
    {
        target->m_frame_buffer.writeRGBA(rgba_bits);
    }
}

bool            WaitForConnection(CameraHandle camera, float timeout)
{
    Camera* target = static_cast<Camera*>(camera);
    if (target && s_camera.load() == target)
    {
        Timer timer;
        while (!target->m_frame_buffer.connected())
        {
            if (0.0f < timeout && timeout <= timer.get())
            {
                return false;
            }
            Timer::sleep(0.001f);
        }
        return true;
    }
    return false;
}

bool            IsConnected(CameraHandle camera)
{
    Camera* target = static_cast<Camera*>(camera);
    if (target && s_camera.load() == target)
    {
        return target->m_frame_buffer.connected();
    }
    return false;
}

} //namespace sender
} //namespace softcam
