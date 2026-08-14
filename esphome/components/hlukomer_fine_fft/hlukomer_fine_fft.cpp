#include "hlukomer_fine_fft.h"

#include "esphome/core/log.h"

#include <esp_http_client.h>

#include <cmath>
#include <cstdio>
#include <cstring>

namespace esphome {
namespace hlukomer_fine_fft {

static const char *const TAG = "hlukomer_fine_fft";

/** Floor used instead of log10(0)/NaN — newlib log10f(0) divides by zero and panics on ESP32. */
static constexpr float kMinPower = 1.0e-20f;

static float sanitize_power(float p) {
  if (!std::isfinite(p) || p < 0.0f)
    return 0.0f;
  return p;
}

static float power_to_db(float p, float offset) {
  if (!std::isfinite(p) || p < kMinPower)
    return offset - 200.0f;
  return 10.0f * log10f(p) + offset;
}

static float clamp_json_db(float db) {
  if (!std::isfinite(db))
    return -99.9f;
  if (db > 199.9f)
    return 199.9f;
  if (db < -199.9f)
    return -199.9f;
  return db;
}

void HlukomerFineFft::setup() {
  if (this->mic_ == nullptr) {
    ESP_LOGE(TAG, "No microphone");
    this->mark_failed();
    return;
  }
  const float two_pi = 6.283185307179586f;
  for (int i = 0; i < FINE_N_BINS; i++) {
    const float freq = static_cast<float>(FINE_F0_HZ + i);
    this->coeff_[i] = 2.0f * cosf(two_pi * freq / static_cast<float>(FINE_FS));
  }
  for (int i = 0; i < FINE_LF_N_BINS; i++) {
    const float freq = static_cast<float>(FINE_LF_F0_HZ + i);
    this->coeff_lf_[i] = 2.0f * cosf(two_pi * freq / static_cast<float>(FINE_FS));
  }

  // passive=true: sdílí stream se sound_level_meter (nestartuje mic sám)
  this->mic_source_ = std::make_unique<microphone::MicrophoneSource>(
      this->mic_, static_cast<uint8_t>(this->bits_per_sample_), this->gain_factor_,
      /*passive=*/true);
  this->mic_source_->add_channel(0);
  this->mic_source_->add_data_callback(
      [this](const std::vector<uint8_t> &data) { this->on_audio_(data); });

  ESP_LOGI(TAG, "Goertzel DFT %d–%d + %d–%d Hz (%d+%d bins), integrate %ds", FINE_F0_HZ,
           FINE_F1_HZ, FINE_LF_F0_HZ, FINE_LF_F1_HZ, FINE_N_BINS, FINE_LF_N_BINS,
           FINE_INTEGRATE_FRAMES);
}

void HlukomerFineFft::loop() {
  if (this->post_pending_) {
    this->post_pending_ = false;
    this->maybe_post_();
  }
}

void HlukomerFineFft::on_audio_(const std::vector<uint8_t> &data) {
  if (data.empty())
    return;

  const int bps = this->bits_per_sample_;
  const size_t bytes_per = (bps <= 16) ? 2 : 4;
  const size_t n = data.size() / bytes_per;
  if (n == 0)
    return;

  const float inv_norm = (bps <= 16) ? (1.0f / 32768.0f) : (1.0f / 2147483648.0f);
  const float two_pi = 6.283185307179586f;
  const float n_fft_f = static_cast<float>(FINE_N_FFT);

  for (size_t s = 0; s < n; s++) {
    float x;
    if (bps <= 16) {
      int16_t v;
      memcpy(&v, data.data() + s * 2, 2);
      x = static_cast<float>(v) * inv_norm;
    } else {
      int32_t v;
      memcpy(&v, data.data() + s * 4, 4);
      x = static_cast<float>(v) * inv_norm;
    }

    const float w =
        0.5f - 0.5f * cosf(two_pi * static_cast<float>(this->sample_i_) / n_fft_f);
    const float xw = x * w;

    for (int b = 0; b < FINE_N_BINS; b++) {
      const float s0 = xw + this->coeff_[b] * this->s_prev_[b] - this->s_prev2_[b];
      this->s_prev2_[b] = this->s_prev_[b];
      this->s_prev_[b] = s0;
    }
    for (int b = 0; b < FINE_LF_N_BINS; b++) {
      const float s0 = xw + this->coeff_lf_[b] * this->s_prev_lf_[b] - this->s_prev2_lf_[b];
      this->s_prev2_lf_[b] = this->s_prev_lf_[b];
      this->s_prev_lf_[b] = s0;
    }

    this->sample_i_++;
    if (this->sample_i_ >= FINE_N_FFT) {
      this->finish_frame_();
    }
  }
}

void HlukomerFineFft::finish_frame_() {
  for (int b = 0; b < FINE_N_BINS; b++) {
    const float s0 = this->s_prev_[b];
    const float s1 = this->s_prev2_[b];
    const float c = this->coeff_[b];
    float power = s1 * s1 + s0 * s0 - c * s0 * s1;
    this->power_acc_[b] += sanitize_power(power);
    this->s_prev_[b] = 0.0f;
    this->s_prev2_[b] = 0.0f;
  }
  for (int b = 0; b < FINE_LF_N_BINS; b++) {
    const float s0 = this->s_prev_lf_[b];
    const float s1 = this->s_prev2_lf_[b];
    const float c = this->coeff_lf_[b];
    float power = s1 * s1 + s0 * s0 - c * s0 * s1;
    this->power_acc_lf_[b] += sanitize_power(power);
    this->s_prev_lf_[b] = 0.0f;
    this->s_prev2_lf_[b] = 0.0f;
  }
  this->sample_i_ = 0;
  this->frames_ready_++;
  if (this->frames_ready_ >= FINE_INTEGRATE_FRAMES) {
    const float inv_frames = 1.0f / static_cast<float>(this->frames_ready_);
    const float norm = (static_cast<float>(FINE_N_FFT) * 0.5f);
    const float norm2 = norm * norm;
    for (int b = 0; b < FINE_N_BINS; b++) {
      this->pending_db_[b] = sanitize_power(this->power_acc_[b] * inv_frames / norm2);
      this->power_acc_[b] = 0.0f;
    }
    for (int b = 0; b < FINE_LF_N_BINS; b++) {
      this->pending_db_lf_[b] = sanitize_power(this->power_acc_lf_[b] * inv_frames / norm2);
      this->power_acc_lf_[b] = 0.0f;
    }
    this->frames_ready_ = 0;
    this->post_pending_ = true;
  }
}

void HlukomerFineFft::maybe_post_() {
  // dB conversion on the main loop — log10f on the I2S/SLM task (core 1) panicked.
  for (int b = 0; b < FINE_N_BINS; b++)
    this->pending_db_[b] = power_to_db(this->pending_db_[b], this->spl_offset_);
  for (int b = 0; b < FINE_LF_N_BINS; b++)
    this->pending_db_lf_[b] = power_to_db(this->pending_db_lf_[b], this->spl_offset_);
  this->post_json_(this->pending_db_, this->pending_db_lf_);
}

bool HlukomerFineFft::post_json_(const float *db, const float *db_lf) {
  static char body[6144];
  int pos = 0;
  pos += snprintf(body + pos, sizeof(body) - pos,
                  "{\"device_id\":\"%s\",\"kind\":\"spectrum_fine\",\"spectrum_fine\":[",
                  this->device_id_.c_str());
  for (int i = 0; i < FINE_N_BINS; i++) {
    if (pos >= static_cast<int>(sizeof(body)) - 16)
      return false;
    pos += snprintf(body + pos, sizeof(body) - pos, i ? ",%.1f" : "%.1f",
                    static_cast<double>(clamp_json_db(db[i])));
  }
  if (pos >= static_cast<int>(sizeof(body)) - 200)
    return false;
  pos += snprintf(body + pos, sizeof(body) - pos,
                  "],\"spectrum_fine_meta\":{\"kind\":\"fft\",\"f0_hz\":%d,\"f1_hz\":%d,"
                  "\"df_hz\":1.0,\"n_fft\":%d,\"window\":\"hann\",\"integrate_s\":%d},"
                  "\"spectrum_fine_lf\":[",
                  FINE_F0_HZ, FINE_F1_HZ, FINE_N_FFT, FINE_INTEGRATE_FRAMES);
  for (int i = 0; i < FINE_LF_N_BINS; i++) {
    if (pos >= static_cast<int>(sizeof(body)) - 16)
      return false;
    pos += snprintf(body + pos, sizeof(body) - pos, i ? ",%.1f" : "%.1f",
                    static_cast<double>(clamp_json_db(db_lf[i])));
  }
  if (pos >= static_cast<int>(sizeof(body)) - 120)
    return false;
  pos += snprintf(body + pos, sizeof(body) - pos,
                  "],\"spectrum_fine_lf_meta\":{\"kind\":\"fft\",\"f0_hz\":%d,\"f1_hz\":%d,"
                  "\"df_hz\":1.0,\"n_fft\":%d,\"window\":\"hann\",\"integrate_s\":%d}}",
                  FINE_LF_F0_HZ, FINE_LF_F1_HZ, FINE_N_FFT, FINE_INTEGRATE_FRAMES);

  esp_http_client_config_t config = {};
  config.url = this->api_url_.c_str();
  config.method = HTTP_METHOD_POST;
  config.timeout_ms = 4000;

  esp_http_client_handle_t client = esp_http_client_init(&config);
  if (client == nullptr) {
    ESP_LOGW(TAG, "HTTP init failed");
    return false;
  }
  esp_http_client_set_header(client, "Content-Type", "application/json");
  if (!this->api_key_.empty()) {
    esp_http_client_set_header(client, "X-Api-Key", this->api_key_.c_str());
  }
  esp_http_client_set_post_field(client, body, pos);
  const esp_err_t err = esp_http_client_perform(client);
  const int status = esp_http_client_get_status_code(client);
  esp_http_client_cleanup(client);
  if (err != ESP_OK || status < 200 || status >= 300) {
    ESP_LOGW(TAG, "POST failed err=%s status=%d", esp_err_to_name(err), status);
    return false;
  }
  ESP_LOGD(TAG, "Posted fine FFT (%d + %d bins)", FINE_N_BINS, FINE_LF_N_BINS);
  return true;
}

}  // namespace hlukomer_fine_fft
}  // namespace esphome
