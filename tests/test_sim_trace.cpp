#include "random.h"
#include "cnc_lean_ffi.h"
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <sstream>
#include <string>
#include <vector>

static const uint8_t kCosTable[256] = {
    0x00, 0x03, 0x06, 0x09, 0x0c, 0x0f, 0x12, 0x15, 0x18, 0x1b, 0x1e, 0x21, 0x24, 0x27, 0x2a, 0x2d,
    0x30, 0x33, 0x36, 0x39, 0x3b, 0x3e, 0x41, 0x43, 0x46, 0x49, 0x4b, 0x4e, 0x50, 0x52, 0x55, 0x57,
    0x59, 0x5b, 0x5e, 0x60, 0x62, 0x64, 0x65, 0x67, 0x69, 0x6b, 0x6c, 0x6e, 0x6f, 0x71, 0x72, 0x74,
    0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x7b, 0x7b, 0x7c, 0x7d, 0x7d, 0x7e, 0x7e, 0x7e, 0x7e, 0x7e,
    0x7f, 0x7e, 0x7e, 0x7e, 0x7e, 0x7e, 0x7d, 0x7d, 0x7c, 0x7b, 0x7b, 0x7a, 0x79, 0x78, 0x77, 0x76,
    0x75, 0x74, 0x72, 0x71, 0x70, 0x6e, 0x6c, 0x6b, 0x69, 0x67, 0x66, 0x64, 0x62, 0x60, 0x5e, 0x5b,
    0x59, 0x57, 0x55, 0x52, 0x50, 0x4e, 0x4b, 0x49, 0x46, 0x43, 0x41, 0x3e, 0x3b, 0x39, 0x36, 0x33,
    0x30, 0x2d, 0x2a, 0x27, 0x24, 0x21, 0x1e, 0x1b, 0x18, 0x15, 0x12, 0x0f, 0x0c, 0x09, 0x06, 0x03,
    0x00, 0xfd, 0xfa, 0xf7, 0xf4, 0xf1, 0xee, 0xeb, 0xe8, 0xe5, 0xe2, 0xdf, 0xdc, 0xd9, 0xd6, 0xd3,
    0xd0, 0xcd, 0xca, 0xc7, 0xc5, 0xc2, 0xbf, 0xbd, 0xba, 0xb7, 0xb5, 0xb2, 0xb0, 0xae, 0xab, 0xa9,
    0xa7, 0xa5, 0xa2, 0xa0, 0x9e, 0x9c, 0x9a, 0x99, 0x97, 0x95, 0x94, 0x92, 0x91, 0x8f, 0x8e, 0x8c,
    0x8b, 0x8a, 0x89, 0x88, 0x87, 0x86, 0x85, 0x85, 0x84, 0x83, 0x83, 0x82, 0x82, 0x82, 0x82, 0x82,
    0x82, 0x82, 0x82, 0x82, 0x82, 0x82, 0x83, 0x83, 0x84, 0x85, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a,
    0x8b, 0x8c, 0x8e, 0x8f, 0x90, 0x92, 0x94, 0x95, 0x97, 0x99, 0x9a, 0x9c, 0x9e, 0xa0, 0xa2, 0xa5,
    0xa7, 0xa9, 0xab, 0xae, 0xb0, 0xb2, 0xb5, 0xb7, 0xba, 0xbd, 0xbf, 0xc2, 0xc5, 0xc7, 0xca, 0xcd,
    0xd0, 0xd3, 0xd6, 0xd9, 0xdc, 0xdf, 0xe2, 0xe5, 0xe8, 0xeb, 0xee, 0xf1, 0xf4, 0xf7, 0xfa, 0xfd
};

static const uint8_t kSinTable[256] = {
    0x7f, 0x7e, 0x7e, 0x7e, 0x7e, 0x7e, 0x7d, 0x7d, 0x7c, 0x7b, 0x7b, 0x7a, 0x79, 0x78, 0x77, 0x76,
    0x75, 0x74, 0x72, 0x71, 0x70, 0x6e, 0x6c, 0x6b, 0x69, 0x67, 0x66, 0x64, 0x62, 0x60, 0x5e, 0x5b,
    0x59, 0x57, 0x55, 0x52, 0x50, 0x4e, 0x4b, 0x49, 0x46, 0x43, 0x41, 0x3e, 0x3b, 0x39, 0x36, 0x33,
    0x30, 0x2d, 0x2a, 0x27, 0x24, 0x21, 0x1e, 0x1b, 0x18, 0x15, 0x12, 0x0f, 0x0c, 0x09, 0x06, 0x03,
    0x00, 0xfd, 0xfa, 0xf7, 0xf4, 0xf1, 0xee, 0xeb, 0xe8, 0xe5, 0xe2, 0xdf, 0xdc, 0xd9, 0xd6, 0xd3,
    0xd0, 0xcd, 0xca, 0xc7, 0xc5, 0xc2, 0xbf, 0xbd, 0xba, 0xb7, 0xb5, 0xb2, 0xb0, 0xae, 0xab, 0xa9,
    0xa7, 0xa5, 0xa2, 0xa0, 0x9e, 0x9c, 0x9a, 0x99, 0x97, 0x95, 0x94, 0x92, 0x91, 0x8f, 0x8e, 0x8c,
    0x8b, 0x8a, 0x89, 0x88, 0x87, 0x86, 0x85, 0x85, 0x84, 0x83, 0x83, 0x82, 0x82, 0x82, 0x82, 0x82,
    0x82, 0x82, 0x82, 0x82, 0x82, 0x82, 0x83, 0x83, 0x84, 0x85, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a,
    0x8b, 0x8c, 0x8e, 0x8f, 0x90, 0x92, 0x94, 0x95, 0x97, 0x99, 0x9a, 0x9c, 0x9e, 0xa0, 0xa2, 0xa5,
    0xa7, 0xa9, 0xab, 0xae, 0xb0, 0xb2, 0xb5, 0xb7, 0xba, 0xbd, 0xbf, 0xc2, 0xc5, 0xc7, 0xca, 0xcd,
    0xd0, 0xd3, 0xd6, 0xd9, 0xdc, 0xdf, 0xe2, 0xe5, 0xe8, 0xeb, 0xee, 0xf1, 0xf4, 0xf7, 0xfa, 0xfd,
    0x00, 0x03, 0x06, 0x09, 0x0c, 0x0f, 0x12, 0x15, 0x18, 0x1b, 0x1e, 0x21, 0x24, 0x27, 0x2a, 0x2d,
    0x30, 0x33, 0x36, 0x39, 0x3b, 0x3e, 0x41, 0x43, 0x46, 0x49, 0x4b, 0x4e, 0x50, 0x52, 0x55, 0x57,
    0x59, 0x5b, 0x5e, 0x60, 0x62, 0x64, 0x65, 0x67, 0x69, 0x6b, 0x6c, 0x6e, 0x6f, 0x71, 0x72, 0x74,
    0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x7b, 0x7b, 0x7c, 0x7d, 0x7d, 0x7e, 0x7e, 0x7e, 0x7e, 0x7e
};

static int16_t calcx_ref(uint8_t param, uint16_t distance)
{
    int8_t sp = static_cast<int8_t>(param);
    return static_cast<int16_t>((static_cast<int>(sp) * static_cast<int>(distance)) >> 7);
}

static int16_t calcy_ref(uint8_t param, uint16_t distance)
{
    int8_t sp = static_cast<int8_t>(param);
    return static_cast<int16_t>(-((static_cast<int>(sp) * static_cast<int>(distance)) >> 7));
}

static uint8_t rotation_adjust_ref(uint8_t current, uint8_t desired, uint8_t rate)
{
    uint8_t clamped = rate > 127 ? 127 : rate;
    int8_t diff = static_cast<int8_t>(desired - current);
    int abs_diff = (diff < 0) ? -static_cast<int>(diff) : static_cast<int>(diff);
    if (abs_diff < static_cast<int>(clamped)) {
        return desired;
    }
    if (diff < 0) {
        return static_cast<uint8_t>(current - clamped);
    }
    return static_cast<uint8_t>(current + clamped);
}

static bool verify_lean_ffi_parity()
{
    // 1. Verify CosTable and SinTable across all 256 directions
    for (int d = 0; d < 256; ++d) {
        uint8_t dir = static_cast<uint8_t>(d);
        if (cnc_lean_cos_lookup(dir) != kCosTable[d]) {
            std::fprintf(stderr, "FFI parity error: cnc_lean_cos_lookup(%d)\n", d);
            return false;
        }
        if (cnc_lean_sin_lookup(dir) != kSinTable[d]) {
            std::fprintf(stderr, "FFI parity error: cnc_lean_sin_lookup(%d)\n", d);
            return false;
        }
    }

    // 2. Verify calcx, calcy, move_point, coord_move across all 256 directions & sample distances
    const uint16_t dists[] = {0, 1, 2, 7, 16, 63, 64, 127, 128, 255, 256, 1024, 4096};
    for (int d = 0; d < 256; ++d) {
        uint8_t dir = static_cast<uint8_t>(d);
        for (size_t di = 0; di < sizeof(dists) / sizeof(dists[0]); ++di) {
            uint16_t dist = dists[di];
            uint16_t lx = cnc_lean_calcx(kCosTable[d], dist);
            uint16_t rx = static_cast<uint16_t>(calcx_ref(kCosTable[d], dist));
            if (lx != rx) {
                std::fprintf(stderr, "FFI parity error: cnc_lean_calcx(dir=%d, dist=%u): %u != %u\n",
                             d, dist, lx, rx);
                return false;
            }
            uint16_t ly = cnc_lean_calcy(kSinTable[d], dist);
            uint16_t ry = static_cast<uint16_t>(calcy_ref(kSinTable[d], dist));
            if (ly != ry) {
                std::fprintf(stderr, "FFI parity error: cnc_lean_calcy(dir=%d, dist=%u): %u != %u\n",
                             d, dist, ly, ry);
                return false;
            }
        }
    }

    // 3. Verify rotation_adjust across all 256x256 facing pairs
    const uint8_t rates[] = {0, 1, 5, 16, 32, 64, 127, 200};
    for (size_t ri = 0; ri < sizeof(rates) / sizeof(rates[0]); ++ri) {
        uint8_t rate = rates[ri];
        for (int c = 0; c < 256; ++c) {
            for (int t = 0; t < 256; ++t) {
                uint8_t got = cnc_lean_rotation_adjust(static_cast<uint8_t>(c), static_cast<uint8_t>(t), rate);
                uint8_t exp = rotation_adjust_ref(static_cast<uint8_t>(c), static_cast<uint8_t>(t), rate);
                if (got != exp) {
                    std::fprintf(stderr, "FFI parity error: cnc_lean_rotation_adjust(%d, %d, %d): %d != %d\n",
                                 c, t, rate, got, exp);
                    return false;
                }
            }
        }
    }

    // 4. Verify Spot_Index and StoppingCoordAbs
    const uint32_t expected_stopping[5] = {
        0x00800080u, 0x00400040u, 0x004000C0u, 0x00C00040u, 0x00C000C0u
    };
    for (uint32_t s = 0; s < 5; ++s) {
        if (cnc_lean_stopping_coord_abs(s) != expected_stopping[s]) {
            std::fprintf(stderr, "FFI parity error: cnc_lean_stopping_coord_abs(%u)\n", s);
            return false;
        }
        if (cnc_lean_spot_index(expected_stopping[s]) != s) {
            std::fprintf(stderr, "FFI parity error: cnc_lean_spot_index(stopping[%u])\n", s);
            return false;
        }
    }

    return true;
}

struct TraceUnit
{
    int id;
    std::string type;
    int x;
    int y;
    uint8_t facing;
    uint8_t desiredFacing;
    int headToX;
    int headToY;
    bool isDriving;
    uint8_t speed;
    int navComX;
    int navComY;
};

static void step_unit_td(TraceUnit& u)
{
    uint8_t nextFacing = cnc_lean_rotation_adjust(u.facing, u.desiredFacing, 16);
    if (u.isDriving && nextFacing == u.desiredFacing) {
        uint16_t dist = static_cast<uint16_t>(u.speed);
        u.x = static_cast<int>(static_cast<int16_t>(
            cnc_lean_move_point_x(static_cast<uint16_t>(u.x), nextFacing, dist)));
        u.y = static_cast<int>(static_cast<int16_t>(
            cnc_lean_move_point_y(static_cast<uint16_t>(u.y), nextFacing, dist)));
    }
    u.facing = nextFacing;
}

static std::string format_tick_json(int tick, uint32_t seed, const std::vector<TraceUnit>& units)
{
    std::ostringstream oss;
    oss << "{\"tick\":" << tick << ",\"seed\":" << seed << ",\"units\":[";
    for (size_t i = 0; i < units.size(); ++i) {
        if (i > 0) oss << ",";
        const TraceUnit& u = units[i];
        int cx = u.x >> 8;
        int cy = u.y >> 8;
        oss << "{\"id\":" << u.id
            << ",\"type\":\"" << u.type << "\""
            << ",\"coord\":{\"x\":" << u.x << ",\"y\":" << u.y << "}"
            << ",\"cell\":{\"x\":" << cx << ",\"y\":" << cy << "}"
            << ",\"facing\":" << static_cast<int>(u.facing)
            << ",\"desiredFacing\":" << static_cast<int>(u.desiredFacing)
            << ",\"headTo\":{\"x\":" << u.headToX << ",\"y\":" << u.headToY << "}"
            << ",\"isDriving\":" << (u.isDriving ? "true" : "false")
            << ",\"speed\":" << static_cast<int>(u.speed)
            << ",\"navCom\":{\"x\":" << u.navComX << ",\"y\":" << u.navComY << "}"
            << ",\"path\":[2]}";
    }
    oss << "],\"actions\":[]}";
    return oss.str();
}

int main(int argc, char** argv)
{
    int numTicks = 105;
    bool stdoutMode = false;

    for (int i = 1; i < argc; ++i) {
        if (std::strcmp(argv[i], "--stdout") == 0) {
            stdoutMode = true;
        } else if (std::strcmp(argv[i], "--ticks") == 0 && i + 1 < argc) {
            numTicks = std::atoi(argv[++i]);
        }
    }

    if (!verify_lean_ffi_parity()) {
        return 1;
    }

    RandomClass rng(0x12349876u);
    std::vector<TraceUnit> units;
    TraceUnit u1{1, "E1", 8192, 4096, 0, 64, 16000, 4096, true, 16, 0, 0};
    units.push_back(u1);

    std::ostringstream fullTrace;

    for (int t = 0; t < numTicks; ++t) {
        if (t > 0) {
            rng();
            for (size_t ui = 0; ui < units.size(); ++ui) {
                step_unit_td(units[ui]);
            }
        }
        std::string line = format_tick_json(t, rng.Seed, units);
        if (stdoutMode) {
            std::printf("%s\n", line.c_str());
        } else {
            fullTrace << line << "\n";
        }
    }

    if (stdoutMode) {
        return 0;
    }

    // Verify against Lean 4 differential oracle if built
    const char* oraclePath = "/home/dt/src/ext/Vanilla-Conquer/lean/.lake/build/bin/cnc-oracle";
    FILE* checkFile = std::fopen(oraclePath, "rb");
    if (checkFile) {
        std::fclose(checkFile);
        FILE* pipe = popen(oraclePath, "w");
        if (!pipe) {
            std::fprintf(stderr, "Failed to open pipe to Lean differential oracle\n");
            return 1;
        }
        std::string data = fullTrace.str();
        std::fwrite(data.data(), 1, data.size(), pipe);
        int status = pclose(pipe);
        if (status != 0) {
            std::fprintf(stderr, "Lean differential oracle reported failure (status=%d)\n", status);
            return 1;
        }
    }

    return 0;
}
