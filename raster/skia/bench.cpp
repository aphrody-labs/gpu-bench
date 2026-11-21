// Skia CPU raster harness: plays a .scene file (grammar in raster/scenes.ts) and reports per-frame timings as JSON.
#include <sys/resource.h>
#include <time.h>

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

#include "include/core/SkBitmap.h"
#include "include/core/SkBlendMode.h"
#include "include/core/SkCanvas.h"
#include "include/core/SkData.h"
#include "include/core/SkFont.h"
#include "include/core/SkFontMgr.h"
#include "include/core/SkImage.h"
#include "include/core/SkMaskFilter.h"
#include "include/core/SkPaint.h"
#include "include/core/SkPathBuilder.h"
#include "include/core/SkPixmap.h"
#include "include/core/SkSamplingOptions.h"
#include "include/core/SkSurface.h"
#include "include/core/SkTextBlob.h"
#include "include/effects/SkDashPathEffect.h"
#include "include/effects/SkGradient.h"
#include "include/ports/SkFontMgr_data.h"
#include "modules/skshaper/include/SkShaper.h"
#include "modules/skshaper/include/SkShaper_harfbuzz.h"
#include "modules/skunicode/include/SkUnicode_icu.h"

namespace {

using Clock = std::chrono::steady_clock;

double threadCpuMs() {
    timespec ts;
    clock_gettime(CLOCK_THREAD_CPUTIME_ID, &ts);
    return ts.tv_sec * 1e3 + ts.tv_nsec / 1e6;
}

const char* const kBlendNames[] = {"clear", "src", "dst", "srcover", "dstover", "srcin", "dstin", "srcout", "dstout", "srcatop", "dstatop", "xor", "plus", "modulate", "screen", "overlay", "darken", "lighten", "colordodge", "colorburn", "hardlight", "softlight", "difference", "exclusion", "multiply", "hue", "saturation", "color", "luminosity"};
const SkBlendMode kBlendModes[] = {SkBlendMode::kClear, SkBlendMode::kSrc, SkBlendMode::kDst, SkBlendMode::kSrcOver, SkBlendMode::kDstOver, SkBlendMode::kSrcIn, SkBlendMode::kDstIn, SkBlendMode::kSrcOut, SkBlendMode::kDstOut, SkBlendMode::kSrcATop, SkBlendMode::kDstATop, SkBlendMode::kXor, SkBlendMode::kPlus, SkBlendMode::kModulate, SkBlendMode::kScreen, SkBlendMode::kOverlay, SkBlendMode::kDarken, SkBlendMode::kLighten, SkBlendMode::kColorDodge, SkBlendMode::kColorBurn, SkBlendMode::kHardLight, SkBlendMode::kSoftLight, SkBlendMode::kDifference, SkBlendMode::kExclusion, SkBlendMode::kMultiply, SkBlendMode::kHue, SkBlendMode::kSaturation, SkBlendMode::kColor, SkBlendMode::kLuminosity};

struct Op {
    std::string kind;
    std::vector<std::string> tokens;
    std::string text;
};

struct Scene {
    int width = 0, height = 0;
    bool shapeEveryFrame = false;
    std::map<std::string, SkPath> paths;
    std::map<std::string, sk_sp<SkImage>> images;
    std::map<std::string, sk_sp<SkTypeface>> fonts;
    std::vector<Op> ops;
};

std::vector<std::string> split(const std::string& line) {
    std::vector<std::string> out;
    std::istringstream stream(line);
    for (std::string token; stream >> token;) out.push_back(token);
    return out;
}

sk_sp<SkData> readFile(const std::string& path) {
    return SkData::MakeFromFileName(path.c_str());
}

SkTileMode spread(const std::string& name) {
    return name == "repeat" ? SkTileMode::kRepeat : name == "reflect" ? SkTileMode::kMirror : SkTileMode::kClamp;
}

SkPath parsePath(const std::vector<std::string>& tokens, size_t from) {
    SkPathBuilder builder;
    size_t i = from;
    auto num = [&]() { return static_cast<float>(std::atof(tokens[i++].c_str())); };
    while (i < tokens.size()) {
        const std::string cmd = tokens[i++];
        if (cmd == "M") { float x = num(), y = num(); builder.moveTo(x, y); }
        else if (cmd == "L") { float x = num(), y = num(); builder.lineTo(x, y); }
        else if (cmd == "Q") { float a = num(), b = num(), c = num(), d = num(); builder.quadTo(a, b, c, d); }
        else if (cmd == "C") { float a = num(), b = num(), c = num(), d = num(), e = num(), f = num(); builder.cubicTo(a, b, c, d, e, f); }
        else if (cmd == "Z") builder.close();
    }
    return builder.detach();
}

struct Frame {
    SkCanvas* canvas;
    SkMatrix base;
    SkMatrix xf;
    SkBlendMode blend = SkBlendMode::kSrcOver;
    float dpr = 1;
    float surfaceW = 0, surfaceH = 0;
};

// Returns false when the paint spec is unsupported.
bool makePaint(const std::vector<std::string>& t, size_t& i, SkPaint& paint) {
    const std::string kind = t[i++];
    auto num = [&]() { return static_cast<float>(std::atof(t[i++].c_str())); };
    auto color = [&]() { float r = num(), g = num(), b = num(), a = num(); return SkColor4f{r / 255, g / 255, b / 255, a / 255}; };
    if (kind == "solid") { paint.setColor4f(color(), nullptr); return true; }
    float v[8] = {};
    int count = 0;
    if (kind == "lin") count = 4; else if (kind == "rad") count = 3; else if (kind == "rad2") count = 6; else if (kind == "con") count = 4;
    for (int k = 0; k < count; k++) v[k] = num();
    const SkTileMode mode = spread(t[i++]);
    const int stops = std::atoi(t[i++].c_str());
    std::vector<SkColor4f> colors;
    std::vector<float> positions;
    for (int k = 0; k < stops; k++) { positions.push_back(num()); colors.push_back(color()); }
    SkGradient gradient(SkGradient::Colors(colors, positions, mode), SkGradient::Interpolation{});
    sk_sp<SkShader> shader;
    if (kind == "lin") { SkPoint pts[2] = {{v[0], v[1]}, {v[2], v[3]}}; shader = SkShaders::LinearGradient(pts, gradient); }
    else if (kind == "rad") shader = SkShaders::RadialGradient({v[0], v[1]}, v[2], gradient);
    else if (kind == "rad2") shader = SkShaders::TwoPointConicalGradient({v[0], v[1]}, v[2], {v[3], v[4]}, v[5], gradient);
    else shader = SkShaders::SweepGradient({v[0], v[1]}, v[2], v[3], gradient);
    if (!shader) return false;
    paint.setShader(shader);
    return true;
}

struct Text {
    sk_sp<SkFontMgr> fontMgr;
    std::unique_ptr<SkShaper> shaper;
    std::map<size_t, sk_sp<SkTextBlob>> cache;
};

sk_sp<SkTextBlob> shapeLine(Text& text, const std::string& line, const SkFont& font) {
    SkTextBlobBuilderRunHandler handler(line.c_str(), {0, 0});
    text.shaper->shape(line.c_str(), line.size(), font, true, 1e9f, &handler);
    return handler.makeBlob();
}

bool playFrame(const Scene& scene, Frame& f, Text& text) {
    SkCanvas* canvas = f.canvas;
    canvas->restoreToCount(1);
    f.xf = SkMatrix::I();
    f.blend = SkBlendMode::kSrcOver;
    for (size_t index = 0; index < scene.ops.size(); index++) {
        const Op& op = scene.ops[index];
        const auto& t = op.tokens;
        auto apply = [&]() { canvas->setMatrix(SkMatrix::Concat(f.base, f.xf)); };
        if (op.kind == "clear") {
            canvas->clear(SkColorSetARGB(std::atoi(t[3].c_str()), std::atoi(t[0].c_str()), std::atoi(t[1].c_str()), std::atoi(t[2].c_str())));
        } else if (op.kind == "save") canvas->save();
        else if (op.kind == "restore") canvas->restore();
        else if (op.kind == "xf") {
            float a = std::atof(t[0].c_str()), b = std::atof(t[1].c_str()), c = std::atof(t[2].c_str()), d = std::atof(t[3].c_str()), e = std::atof(t[4].c_str()), g = std::atof(t[5].c_str());
            f.xf = SkMatrix::MakeAll(a, c, e, b, d, g, 0, 0, 1);
        } else if (op.kind == "blend") {
            for (size_t k = 0; k < 29; k++) if (t[0] == kBlendNames[k]) f.blend = kBlendModes[k];
        } else if (op.kind == "clip") {
            apply();
            canvas->clipPath(scene.paths.at(t[0]), t[1] == "1");
        } else if (op.kind == "fill" || op.kind == "rect") {
            SkPaint paint;
            paint.setAntiAlias(true);
            paint.setBlendMode(f.blend);
            size_t i = 0;
            apply();
            if (op.kind == "fill") {
                SkPath path = scene.paths.at(t[0]);
                if (t[1] == "eo") path = SkPathBuilder(path).setFillType(SkPathFillType::kEvenOdd).detach();
                paint.setAntiAlias(t[2] == "1");
                i = 3;
                if (!makePaint(t, i, paint)) continue;
                canvas->drawPath(path, paint);
            } else {
                paint.setAntiAlias(t[4] == "1");
                i = 5;
                if (!makePaint(t, i, paint)) continue;
                canvas->drawRect(SkRect::MakeXYWH(std::atof(t[0].c_str()), std::atof(t[1].c_str()), std::atof(t[2].c_str()), std::atof(t[3].c_str())), paint);
            }
        } else if (op.kind == "stroke") {
            SkPaint paint;
            paint.setBlendMode(f.blend);
            paint.setStyle(SkPaint::kStroke_Style);
            paint.setStrokeWidth(std::atof(t[1].c_str()));
            paint.setStrokeCap(t[2] == "round" ? SkPaint::kRound_Cap : t[2] == "square" ? SkPaint::kSquare_Cap : SkPaint::kButt_Cap);
            paint.setStrokeJoin(t[3] == "round" ? SkPaint::kRound_Join : t[3] == "bevel" ? SkPaint::kBevel_Join : SkPaint::kMiter_Join);
            paint.setStrokeMiter(std::atof(t[4].c_str()));
            size_t i = 5;
            if (t[i] == "-") i++;
            else {
                i++;
                const int n = std::atoi(t[i++].c_str());
                std::vector<float> intervals;
                for (int k = 0; k < n; k++) intervals.push_back(std::atof(t[i++].c_str()));
                paint.setPathEffect(SkDashPathEffect::Make(intervals, std::atof(t[i++].c_str())));
            }
            paint.setAntiAlias(t[i++] == "1");
            if (!makePaint(t, i, paint)) continue;
            apply();
            canvas->drawPath(scene.paths.at(t[0]), paint);
        } else if (op.kind == "image") {
            SkSamplingOptions sampling = t[5] == "nearest" ? SkSamplingOptions(SkFilterMode::kNearest)
                : t[5] == "bilinear" ? SkSamplingOptions(SkFilterMode::kLinear)
                : t[5] == "bicubic" ? SkSamplingOptions(SkCubicResampler::Mitchell())
                : SkSamplingOptions(SkFilterMode::kLinear, SkMipmapMode::kLinear);
            SkPaint paint;
            paint.setBlendMode(f.blend);
            paint.setAlphaf(std::atof(t[6].c_str()));
            paint.setAntiAlias(true);
            apply();
            canvas->drawImageRect(scene.images.at(t[0]).get(), SkRect::MakeXYWH(std::atof(t[1].c_str()), std::atof(t[2].c_str()), std::atof(t[3].c_str()), std::atof(t[4].c_str())), sampling, &paint);
        } else if (op.kind == "blur") {
            SkPaint paint;
            paint.setAntiAlias(true);
            paint.setColor(SkColorSetARGB(std::atoi(t[5].c_str()), std::atoi(t[2].c_str()), std::atoi(t[3].c_str()), std::atoi(t[4].c_str())));
            paint.setMaskFilter(SkMaskFilter::MakeBlur(kNormal_SkBlurStyle, std::atof(t[1].c_str())));
            apply();
            canvas->drawPath(scene.paths.at(t[0]), paint);
        } else if (op.kind == "text") {
            const float size = std::atof(t[1].c_str()) * f.dpr;
            SkFont font(scene.fonts.at(t[0]), size);
            font.setSubpixel(true);
            font.setEdging(SkFont::Edging::kAntiAlias);
            font.setHinting(SkFontHinting::kNormal);
            sk_sp<SkTextBlob> blob;
            if (scene.shapeEveryFrame) blob = shapeLine(text, op.text, font);
            else {
                auto& slot = text.cache[index];
                if (!slot) slot = shapeLine(text, op.text, font);
                blob = slot;
            }
            SkPaint paint;
            paint.setAntiAlias(true);
            paint.setColor(SkColorSetARGB(std::atoi(t[7].c_str()), std::atoi(t[4].c_str()), std::atoi(t[5].c_str()), std::atoi(t[6].c_str())));
            canvas->setMatrix(SkMatrix::I());
            canvas->drawTextBlob(blob, std::atof(t[2].c_str()) * f.dpr, std::atof(t[3].c_str()) * f.dpr, paint);
        }
    }
    return true;
}

}  // namespace

int main(int argc, char** argv) {
    std::string scenePath, outPath;
    float dpr = 1;
    int runs = 30, warmup = 5;
    for (int i = 1; i < argc; i++) {
        const std::string arg = argv[i];
        if (arg == "--scene") scenePath = argv[++i];
        else if (arg == "--dpr") dpr = std::atof(argv[++i]);
        else if (arg == "--runs") runs = std::atoi(argv[++i]);
        else if (arg == "--warmup") warmup = std::atoi(argv[++i]);
        else if (arg == "--out") outPath = argv[++i];
    }
    struct rusage baseline;
    getrusage(RUSAGE_SELF, &baseline);

    const std::string dir = scenePath.substr(0, scenePath.find_last_of("/\\") + 1);
    Scene scene;
    Text text;
    std::ifstream file(scenePath);
    std::string line;
    std::vector<sk_sp<SkData>> fontData;
    while (std::getline(file, line)) {
        if (line.empty()) continue;
        std::string kind = line.substr(0, line.find(' '));
        if (kind == "text") {
            const size_t bar = line.find(" | ");
            Op op{kind, split(line.substr(0, bar)), line.substr(bar + 3)};
            op.tokens.erase(op.tokens.begin());
            scene.ops.push_back(op);
            continue;
        }
        auto t = split(line);
        t.erase(t.begin());
        if (kind == "scene") {
            scene.width = std::atoi(t[0].c_str());
            scene.height = std::atoi(t[1].c_str());
            for (size_t k = 2; k + 1 < t.size(); k += 2) if (t[k] == "textmode") scene.shapeEveryFrame = t[k + 1] == "shape";
        } else if (kind == "font") {
            sk_sp<SkData> data = readFile(dir + t[1]);
            if (!data) { std::fprintf(stderr, "cannot read font %s\n", t[1].c_str()); return 1; }
            fontData.push_back(data);
            text.fontMgr = SkFontMgr_New_Custom_Data(SkSpan<sk_sp<SkData>>(fontData));
            scene.fonts[t[0]] = text.fontMgr->makeFromData(data);
        } else if (kind == "img") {
            const int w = std::atoi(t[1].c_str()), h = std::atoi(t[2].c_str());
            sk_sp<SkData> data = readFile(dir + t[3]);
            if (!data) { std::fprintf(stderr, "cannot read image %s\n", t[3].c_str()); return 1; }
            scene.images[t[0]] = SkImages::RasterFromData(SkImageInfo::Make(w, h, kRGBA_8888_SkColorType, kPremul_SkAlphaType), data, w * 4);
        } else if (kind == "path") {
            scene.paths[t[0]] = parsePath(t, 1);
        } else {
            scene.ops.push_back(Op{kind, t, ""});
        }
    }
    if (text.fontMgr) text.shaper = SkShapers::HB::ShapeDontWrapOrReorder(SkUnicodes::ICU::Make(), text.fontMgr);

    const int pixelsW = static_cast<int>(scene.width * dpr), pixelsH = static_cast<int>(scene.height * dpr);
    sk_sp<SkSurface> surface = SkSurfaces::Raster(SkImageInfo::Make(pixelsW, pixelsH, kRGBA_8888_SkColorType, kPremul_SkAlphaType));
    Frame frame;
    frame.canvas = surface->getCanvas();
    frame.base = SkMatrix::Scale(dpr, dpr);
    frame.dpr = dpr;

    std::vector<double> times, cpuTimes;
    double firstMs = 0;
    for (int run = 0; run < warmup + runs + 1; run++) {
        const double cpuStart = threadCpuMs();
        const auto start = Clock::now();
        playFrame(scene, frame, text);
        const double ms = std::chrono::duration<double, std::milli>(Clock::now() - start).count();
        const double cpuMs = threadCpuMs() - cpuStart;
        if (run == 0) firstMs = ms;
        else if (run > warmup) { times.push_back(ms); cpuTimes.push_back(cpuMs); }
    }
    struct rusage peak;
    getrusage(RUSAGE_SELF, &peak);

    if (!outPath.empty()) {
        SkPixmap pixmap;
        surface->peekPixels(&pixmap);
        FILE* out = std::fopen(outPath.c_str(), "wb");
        for (int y = 0; y < pixelsH; y++) std::fwrite(pixmap.addr(0, y), 4, pixelsW, out);
        std::fclose(out);
    }
    std::printf("{\"engine\":\"skia\",\"width\":%d,\"height\":%d,\"dpr\":%g,\"first_ms\":%.4f,\"rss_kb\":%ld,\"rss_baseline_kb\":%ld,\"times_ms\":[", pixelsW, pixelsH, dpr, firstMs, peak.ru_maxrss, baseline.ru_maxrss);
    for (size_t i = 0; i < times.size(); i++) std::printf("%s%.4f", i ? "," : "", times[i]);
    std::printf("],\"cpu_times_ms\":[");
    for (size_t i = 0; i < cpuTimes.size(); i++) std::printf("%s%.4f", i ? "," : "", cpuTimes[i]);
    std::printf("]}\n");
    return 0;
}
