#pragma once

#include "esphome/core/component.h"
#include "esphome/components/microphone/microphone.h"
#include "esphome/components/microphone/microphone_source.h"

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

namespace esphome {
namespace hlukomer_fine_fft {

static const int FINE_F0_HZ = 150;
static const int FINE_F1_HZ = 270;
static const int FINE_N_BINS = FINE_F1_HZ - FINE_F0_HZ + 1;  // 121

/** Low-band fine FFT: 25–150 Hz (1/3-oktáva floor … under mains/HVAC tones). */
static const int FINE_LF_F0_HZ = 25;
static const int FINE_LF_F1_HZ = 150;
static const int FINE_LF_N_BINS = FINE_LF_F1_HZ - FINE_LF_F0_HZ + 1;  // 126

/** One Goertzel bank covering both spectrograms (150 Hz shared). */
static const int FINE_ALL_F0_HZ = FINE_LF_F0_HZ;
static const int FINE_ALL_F1_HZ = FINE_F1_HZ;
static const int FINE_ALL_N_BINS = FINE_ALL_F1_HZ - FINE_ALL_F0_HZ + 1;  // 246
static const int FINE_HF_OFFSET = FINE_F0_HZ - FINE_ALL_F0_HZ;           // 125

static const int FINE_FS = 48000;
/** Boxcar decimate 48 kHz → 4 kHz so Goertzel fits next to SLM on ESP32-S3. */
static const int FINE_DECIM = 12;
static const int FINE_FS_DEC = FINE_FS / FINE_DECIM;  // 4000
static const int FINE_N_FFT = FINE_FS_DEC;            // Δf = 1 Hz, 1 s window
static const int FINE_INTEGRATE_FRAMES = 3;
static const int FINE_Q_LEN = 512;  // 128 ms @ 4 kHz, power of 2

/** High-res 150–270 + 25–150 Hz: Goertzel off the I2S/SLM task, 3 s energy avg → HTTP. */
class HlukomerFineFft : public Component {
 public:
  void set_microphone(microphone::Microphone *mic) { this->mic_ = mic; }
  void set_api_url(const std::string &url) { this->api_url_ = url; }
  void set_api_key(const std::string &key) { this->api_key_ = key; }
  void set_device_id(const std::string &id) { this->device_id_ = id; }
  void set_spl_offset(float offset) { this->spl_offset_ = offset; }
  void set_bits_per_sample(int bits) { this->bits_per_sample_ = bits; }
  void set_gain_factor(int32_t gain) { this->gain_factor_ = gain; }

  void setup() override;
  void loop() override;
  float get_setup_priority() const override { return setup_priority::LATE; }

 protected:
  void on_audio_(const std::vector<uint8_t> &data);
  void dsp_loop_();
  void process_decimated_(float xd);
  void finish_frame_();
  void maybe_post_();
  bool post_json_(const float *db, const float *db_lf);
  bool queue_push_(float x);
  bool queue_pop_(float *x);

  microphone::Microphone *mic_{nullptr};
  std::unique_ptr<microphone::MicrophoneSource> mic_source_;
  std::string api_url_;
  std::string api_key_;
  std::string device_id_{"hlukomer"};
  float spl_offset_{94.0f};
  int bits_per_sample_{32};
  int32_t gain_factor_{1};

  float coeff_[FINE_ALL_N_BINS]{};
  float s_prev_[FINE_ALL_N_BINS]{};
  float s_prev2_[FINE_ALL_N_BINS]{};
  float power_acc_[FINE_ALL_N_BINS]{};
  float hann_[FINE_N_FFT]{};

  float q_[FINE_Q_LEN]{};
  std::atomic<uint16_t> q_w_{0};
  std::atomic<uint16_t> q_r_{0};
  TaskHandle_t dsp_task_{nullptr};
  std::atomic<uint32_t> drops_{0};

  int64_t decim_acc_{0};
  int decim_n_{0};
  int sample_i_{0};
  int frames_ready_{0};
  std::atomic<bool> post_pending_{false};
  // Linear power after a 3 s integrate; converted to dB in maybe_post_().
  float pending_db_[FINE_N_BINS]{};
  float pending_db_lf_[FINE_LF_N_BINS]{};
};

}  // namespace hlukomer_fine_fft
}  // namespace esphome
