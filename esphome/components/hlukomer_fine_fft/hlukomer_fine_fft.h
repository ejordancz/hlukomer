#pragma once

#include "esphome/core/component.h"
#include "esphome/components/microphone/microphone.h"
#include "esphome/components/microphone/microphone_source.h"

#include <memory>
#include <string>
#include <vector>

namespace esphome {
namespace hlukomer_fine_fft {

static const int FINE_F0_HZ = 190;
static const int FINE_F1_HZ = 270;
static const int FINE_N_BINS = FINE_F1_HZ - FINE_F0_HZ + 1;  // 81

/** Low-band fine FFT: 25–70 Hz (1/3-oktáva floor … under mains/HVAC tones). */
static const int FINE_LF_F0_HZ = 25;
static const int FINE_LF_F1_HZ = 70;
static const int FINE_LF_N_BINS = FINE_LF_F1_HZ - FINE_LF_F0_HZ + 1;  // 46

static const int FINE_FS = 48000;
static const int FINE_N_FFT = 48000;  // Δf = 1 Hz
static const int FINE_INTEGRATE_FRAMES = 3;

/** High-res 190–270 + 25–70 Hz: Goertzel DFT bins (≡ FFT bins) + Hann, 3 s energy avg → HTTP. */
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
  void finish_frame_();
  void maybe_post_();
  bool post_json_(const float *db, const float *db_lf);

  microphone::Microphone *mic_{nullptr};
  std::unique_ptr<microphone::MicrophoneSource> mic_source_;
  std::string api_url_;
  std::string api_key_;
  std::string device_id_{"hlukomer"};
  float spl_offset_{94.0f};
  int bits_per_sample_{32};
  int32_t gain_factor_{1};

  float coeff_[FINE_N_BINS]{};
  float s_prev_[FINE_N_BINS]{};
  float s_prev2_[FINE_N_BINS]{};
  float power_acc_[FINE_N_BINS]{};

  float coeff_lf_[FINE_LF_N_BINS]{};
  float s_prev_lf_[FINE_LF_N_BINS]{};
  float s_prev2_lf_[FINE_LF_N_BINS]{};
  float power_acc_lf_[FINE_LF_N_BINS]{};

  int sample_i_{0};
  int frames_ready_{0};
  bool post_pending_{false};
  float pending_db_[FINE_N_BINS]{};
  float pending_db_lf_[FINE_LF_N_BINS]{};
};

}  // namespace hlukomer_fine_fft
}  // namespace esphome
