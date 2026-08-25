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
static constexpr uint16_t kQueueMask = static_cast<uint16_t>(FINE_Q_LEN - 1);

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
  const float fs_dec = static_cast<float>(FINE_FS_DEC);
  const float n_fft_f = static_cast<float>(FINE_N_FFT);
  for (int i = 0; i < FINE_ALL_N_BINS; i++) {
    const float freq = static_cast<float>(FINE_ALL_F0_HZ + i);
    this->coeff_[i] = 2.0f * cosf(two_pi * freq / fs_dec);
  }
  for (int i = 0; i < FINE_N_FFT; i++)
    this->hann_[i] = 0.5f - 0.5f * cosf(two_pi * static_cast<float>(i) / n_fft_f);

  // passive=true: sdílí stream se sound_level_meter (nestartuje mic sám)
  this->mic_source_ = std::make_unique<microphone::MicrophoneSource>(
      this->mic_, static_cast<uint8_t>(this->bits_per_sample_), this->gain_factor_,
      /*passive=*/true);
  this->mic_source_->add_channel(0);
  this->mic_source_->add_data_callback(
      [this](const std::vector<uint8_t> &data) { this->on_audio_(data); });

  // Core 0: I2S/SLM typically runs on core 1 — keep HTTP/DSP off that core.
  BaseType_t ok = xTaskCreatePinnedToCore(
      [](void *arg) { static_cast<HlukomerFineFft *>(arg)->dsp_loop_(); }, "fine_fft", 6144,
      this, tskIDLE_PRIORITY + 2, &this->dsp_task_, 0);
  if (ok != pdPASS) {
    ESP_LOGE(TAG, "DSP task create failed");
    this->mark_failed();
    return;
  }
  ok = xTaskCreatePinnedToCore(
      [](void *arg) { static_cast<HlukomerFineFft *>(arg)->post_loop_(); }, "fine_fft_http", 8192,
      this, tskIDLE_PRIORITY + 1, &this->post_task_, 0);
  if (ok != pdPASS) {
    ESP_LOGE(TAG, "HTTP task create failed");
    this->mark_failed();
    return;
  }
  this->disable_loop();

  ESP_LOGI(TAG,
           "Goertzel DFT %d–%d + %d–%d Hz (%d bins, off-I2S), decim %d→%d Hz, integrate %ds",
           FINE_F0_HZ, FINE_F1_HZ, FINE_LF_F0_HZ, FINE_LF_F1_HZ, FINE_ALL_N_BINS, FINE_FS,
           FINE_FS_DEC, FINE_INTEGRATE_FRAMES);
}

bool HlukomerFineFft::queue_push_(float x) {
  const uint16_t w = this->q_w_.load(std::memory_order_relaxed);
  const uint16_t next = (w + 1) & kQueueMask;
  const uint16_t r = this->q_r_.load(std::memory_order_acquire);
  if (next == r)
    return false;
  this->q_[w] = x;
  this->q_w_.store(next, std::memory_order_release);
  return true;
}

bool HlukomerFineFft::queue_pop_(float *x) {
  const uint16_t r = this->q_r_.load(std::memory_order_relaxed);
  const uint16_t w = this->q_w_.load(std::memory_order_acquire);
  if (r == w)
    return false;
  *x = this->q_[r];
  this->q_r_.store((r + 1) & kQueueMask, std::memory_order_release);
  return true;
}

void HlukomerFineFft::on_audio_(const std::vector<uint8_t> &data) {
  if (data.empty())
    return;

  const int bps = this->bits_per_sample_;
  const size_t bytes_per = (bps <= 16) ? 2 : 4;
  const size_t n = data.size() / bytes_per;
  if (n == 0)
    return;

  int64_t acc = this->decim_acc_;
  int dn = this->decim_n_;
  uint32_t drops = 0;

  if (bps > 16) {
    const float scale = (1.0f / 2147483648.0f) / static_cast<float>(FINE_DECIM);
    const int32_t *samples = reinterpret_cast<const int32_t *>(data.data());
    for (size_t s = 0; s < n; s++) {
      acc += samples[s];
      dn++;
      if (dn < FINE_DECIM)
        continue;
      const float xd = static_cast<float>(acc) * scale;
      acc = 0;
      dn = 0;
      if (!this->queue_push_(xd))
        drops++;
    }
  } else {
    const float scale = (1.0f / 32768.0f) / static_cast<float>(FINE_DECIM);
    for (size_t s = 0; s < n; s++) {
      int16_t v;
      memcpy(&v, data.data() + s * 2, 2);
      acc += v;
      dn++;
      if (dn < FINE_DECIM)
        continue;
      const float xd = static_cast<float>(acc) * scale;
      acc = 0;
      dn = 0;
      if (!this->queue_push_(xd))
        drops++;
    }
  }

  this->decim_acc_ = acc;
  this->decim_n_ = dn;
  if (drops)
    this->drops_.fetch_add(drops, std::memory_order_relaxed);
  if (this->dsp_task_ != nullptr)
    xTaskNotifyGive(this->dsp_task_);
}

void HlukomerFineFft::dsp_loop_() {
  for (;;) {
    ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(20));
    float xd;
    while (this->queue_pop_(&xd))
      this->process_decimated_(xd);
  }
}

void HlukomerFineFft::process_decimated_(float xd) {
  const float xw = xd * this->hann_[this->sample_i_];

  for (int b = 0; b < FINE_ALL_N_BINS; b++) {
    const float s0 = xw + this->coeff_[b] * this->s_prev_[b] - this->s_prev2_[b];
    this->s_prev2_[b] = this->s_prev_[b];
    this->s_prev_[b] = s0;
  }

  this->sample_i_++;
  if (this->sample_i_ >= FINE_N_FFT)
    this->finish_frame_();
}

void HlukomerFineFft::finish_frame_() {
  for (int b = 0; b < FINE_ALL_N_BINS; b++) {
    const float s0 = this->s_prev_[b];
    const float s1 = this->s_prev2_[b];
    const float c = this->coeff_[b];
    float power = s1 * s1 + s0 * s0 - c * s0 * s1;
    this->power_acc_[b] += sanitize_power(power);
    this->s_prev_[b] = 0.0f;
    this->s_prev2_[b] = 0.0f;
  }
  this->sample_i_ = 0;
  this->frames_ready_++;
  if (this->frames_ready_ >= FINE_INTEGRATE_FRAMES) {
    const float inv_frames = 1.0f / static_cast<float>(this->frames_ready_);
    const float norm = (static_cast<float>(FINE_N_FFT) * 0.5f);
    const float norm2 = norm * norm;
    for (int b = 0; b < FINE_N_BINS; b++) {
      this->pending_db_[b] =
          sanitize_power(this->power_acc_[FINE_HF_OFFSET + b] * inv_frames / norm2);
    }
    for (int b = 0; b < FINE_LF_N_BINS; b++) {
      this->pending_db_lf_[b] = sanitize_power(this->power_acc_[b] * inv_frames / norm2);
    }
    for (int b = 0; b < FINE_ALL_N_BINS; b++)
      this->power_acc_[b] = 0.0f;
    this->frames_ready_ = 0;
    if (this->post_busy_.load(std::memory_order_acquire))
      return;
    memcpy(this->post_db_, this->pending_db_, sizeof(this->post_db_));
    memcpy(this->post_db_lf_, this->pending_db_lf_, sizeof(this->post_db_lf_));
    this->post_busy_.store(true, std::memory_order_release);
    if (this->post_task_ != nullptr)
      xTaskNotifyGive(this->post_task_);
  }
}

void HlukomerFineFft::post_loop_() {
  for (;;) {
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
    const uint32_t drops = this->drops_.exchange(0, std::memory_order_relaxed);
    if (drops > 0)
      ESP_LOGW(TAG, "Dropped %u decimated samples (DSP behind)", static_cast<unsigned>(drops));
    for (int b = 0; b < FINE_N_BINS; b++)
      this->post_db_[b] = power_to_db(this->post_db_[b], this->spl_offset_);
    for (int b = 0; b < FINE_LF_N_BINS; b++)
      this->post_db_lf_[b] = power_to_db(this->post_db_lf_[b], this->spl_offset_);
    this->post_json_(this->post_db_, this->post_db_lf_);
    this->post_busy_.store(false, std::memory_order_release);
  }
}

bool HlukomerFineFft::post_json_(const float *db, const float *db_lf) {
  static char body[8192];
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
  config.timeout_ms = 2000;

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
