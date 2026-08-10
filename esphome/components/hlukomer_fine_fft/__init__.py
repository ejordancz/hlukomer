import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.components import microphone
from esphome.const import CONF_ID, CONF_MICROPHONE

CODEOWNERS = ["@hlukomer"]
DEPENDENCIES = ["microphone"]

hlukomer_fine_fft_ns = cg.esphome_ns.namespace("hlukomer_fine_fft")
HlukomerFineFft = hlukomer_fine_fft_ns.class_("HlukomerFineFft", cg.Component)

CONF_API_URL = "api_url"
CONF_API_KEY = "api_key"
CONF_DEVICE_ID = "device_id"
CONF_SPL_OFFSET = "spl_offset"
CONF_BITS_PER_SAMPLE = "bits_per_sample"
CONF_GAIN_FACTOR = "gain_factor"

CONFIG_SCHEMA = cv.Schema(
    {
        cv.GenerateID(): cv.declare_id(HlukomerFineFft),
        cv.Required(CONF_MICROPHONE): cv.use_id(microphone.Microphone),
        cv.Required(CONF_API_URL): cv.string,
        cv.Required(CONF_API_KEY): cv.string,
        cv.Optional(CONF_DEVICE_ID, default="hlukomer"): cv.string,
        cv.Optional(CONF_SPL_OFFSET, default=94.0): cv.float_,
        cv.Optional(CONF_BITS_PER_SAMPLE, default=32): cv.int_,
        cv.Optional(CONF_GAIN_FACTOR, default=1): cv.int_,
    }
).extend(cv.COMPONENT_SCHEMA)


async def to_code(config):
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)
    mic = await cg.get_variable(config[CONF_MICROPHONE])
    cg.add(var.set_microphone(mic))
    cg.add(var.set_api_url(config[CONF_API_URL]))
    cg.add(var.set_api_key(config[CONF_API_KEY]))
    cg.add(var.set_device_id(config[CONF_DEVICE_ID]))
    cg.add(var.set_spl_offset(config[CONF_SPL_OFFSET]))
    cg.add(var.set_bits_per_sample(config[CONF_BITS_PER_SAMPLE]))
    cg.add(var.set_gain_factor(config[CONF_GAIN_FACTOR]))
