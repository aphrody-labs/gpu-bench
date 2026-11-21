// Dawn native bench: the same workloads as js/core.ts and bench/wgpu/src/main.rs, against Dawn's prebuilt webgpu_dawn static library.
// Usage: gpu-bench-dawn --wgsl <dir> [--backend d3d12|vulkan] [--only a,b]; prints one JSON document on stdout.
#include <dawn/webgpu_cpp.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <functional>
#include <map>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

namespace {

constexpr uint64_t kElements = 1ull << 26;
constexpr uint64_t kMatrix = 2048;
constexpr uint32_t kWidth = 1920;
constexpr uint32_t kHeight = 1080;
constexpr uint32_t kInstances = 100000;
constexpr uint64_t kStorageLimit = 268435456;
constexpr int kWarmup = 5;
constexpr double kWarmupMs = 1000.0;

using Clock = std::chrono::steady_clock;
double Ms(Clock::time_point start) {
    return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}

struct Sample {
    double cpu = 0, wall = 0, gpu = -1;
};
using Encode = std::function<void(wgpu::CommandEncoder&, const wgpu::PassTimestampWrites*)>;

std::vector<std::string>* gErrors = nullptr;

std::string ReadFile(const std::string& path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) {
        std::fprintf(stderr, "cannot read %s\n", path.c_str());
        std::exit(2);
    }
    std::stringstream buffer;
    buffer << in.rdbuf();
    return buffer.str();
}

std::string Unique(std::string code, int i) {
    const std::string needle = "const SEED = 0u;";
    const size_t at = code.find(needle);
    if (at != std::string::npos) code.replace(at, needle.size(), "const SEED = " + std::to_string(i + 1) + "u;");
    return code;
}

std::string Escape(const std::string& text) {
    std::string out;
    for (char c : text) {
        if (c == '"' || c == '\\') out += '\\';
        if (c == '\n') { out += "\\n"; continue; }
        out += c;
    }
    return out;
}

struct Bench {
    wgpu::Instance instance;
    wgpu::Device device;
    wgpu::Queue queue;
    wgpu::QuerySet querySet;
    wgpu::Buffer resolveBuffer, readBuffer;
    bool timestamps = false;
    std::map<std::string, std::vector<double>> metrics;
    std::map<std::string, std::string> checks;
    std::vector<std::string> errors;

    void Push(const std::string& name, double value) { metrics[name].push_back(value); }
    void Record(const std::string& prefix, const Sample& sample) {
        Push(prefix + ".wall_ms", sample.wall);
        Push(prefix + ".cpu_ms", sample.cpu);
        if (sample.gpu >= 0) Push(prefix + ".gpu_ms", sample.gpu);
    }
    void Wait(const wgpu::Future& future) { instance.WaitAny(future, UINT64_MAX); }
    void Drain() { Wait(queue.OnSubmittedWorkDone(wgpu::CallbackMode::WaitAnyOnly, [](wgpu::QueueWorkDoneStatus, wgpu::StringView) {})); }

    std::vector<uint8_t> MapRead(const wgpu::Buffer& buffer, size_t size) {
        wgpu::MapAsyncStatus result = wgpu::MapAsyncStatus::Error;
        Wait(buffer.MapAsync(wgpu::MapMode::Read, 0, size, wgpu::CallbackMode::WaitAnyOnly, [&](wgpu::MapAsyncStatus status, wgpu::StringView) { result = status; }));
        if (result != wgpu::MapAsyncStatus::Success) errors.push_back("map failed");
        const uint8_t* data = static_cast<const uint8_t*>(buffer.GetConstMappedRange(0, size));
        std::vector<uint8_t> bytes(data, data + size);
        buffer.Unmap();
        return bytes;
    }

    Sample Measure(const Encode& encode) {
        const auto start = Clock::now();
        wgpu::CommandEncoder encoder = device.CreateCommandEncoder();
        wgpu::PassTimestampWrites writes;
        writes.querySet = querySet;
        writes.beginningOfPassWriteIndex = 0;
        writes.endOfPassWriteIndex = 1;
        encode(encoder, timestamps ? &writes : nullptr);
        if (timestamps) {
            encoder.ResolveQuerySet(querySet, 0, 2, resolveBuffer, 0);
            encoder.CopyBufferToBuffer(resolveBuffer, 0, readBuffer, 0, 16);
        }
        wgpu::CommandBuffer commands = encoder.Finish();
        queue.Submit(1, &commands);
        Sample sample;
        sample.cpu = Ms(start);
        if (timestamps) {
            const std::vector<uint8_t> bytes = MapRead(readBuffer, 16);
            uint64_t ticks[2];
            std::memcpy(ticks, bytes.data(), 16);
            sample.gpu = static_cast<double>(ticks[1] - ticks[0]) / 1e6;
        } else {
            Drain();
        }
        sample.wall = Ms(start);
        return sample;
    }

    // At least kWarmup passes and kWarmupMs of continuous work, so the GPU clocks have ramped before anything is timed.
    void Warm(const Encode& encode) {
        const auto start = Clock::now();
        for (int i = 0; i < kWarmup || Ms(start) < kWarmupMs; i++) Measure(encode);
    }

    wgpu::Buffer Storage(uint64_t size) {
        wgpu::BufferDescriptor descriptor;
        descriptor.size = size;
        descriptor.usage = wgpu::BufferUsage::Storage | wgpu::BufferUsage::CopySrc | wgpu::BufferUsage::CopyDst;
        return device.CreateBuffer(&descriptor);
    }

    std::vector<uint8_t> ReadBack(const wgpu::Buffer& source, uint64_t offset, uint64_t size) {
        wgpu::BufferDescriptor descriptor;
        descriptor.size = size;
        descriptor.usage = wgpu::BufferUsage::MapRead | wgpu::BufferUsage::CopyDst;
        wgpu::Buffer staging = device.CreateBuffer(&descriptor);
        wgpu::CommandEncoder encoder = device.CreateCommandEncoder();
        encoder.CopyBufferToBuffer(source, offset, staging, 0, size);
        wgpu::CommandBuffer commands = encoder.Finish();
        queue.Submit(1, &commands);
        std::vector<uint8_t> bytes = MapRead(staging, size);
        staging.Destroy();
        return bytes;
    }

    wgpu::ShaderModule Module(const std::string& code) {
        wgpu::ShaderSourceWGSL wgsl;
        wgsl.code = wgpu::StringView(code.data(), code.size());
        wgpu::ShaderModuleDescriptor descriptor;
        descriptor.nextInChain = &wgsl;
        return device.CreateShaderModule(&descriptor);
    }

    void CompilationInfo(const wgpu::ShaderModule& module) {
        Wait(module.GetCompilationInfo(wgpu::CallbackMode::WaitAnyOnly, [](wgpu::CompilationInfoRequestStatus, const wgpu::CompilationInfo*) {}));
    }

    wgpu::ComputePipeline ComputePipelineOf(const wgpu::ShaderModule& module) {
        wgpu::ComputePipelineDescriptor descriptor;
        descriptor.compute.module = module;
        descriptor.compute.entryPoint = "main";
        return device.CreateComputePipeline(&descriptor);
    }

    wgpu::RenderPipeline RenderPipelineOf(const wgpu::ShaderModule& module, bool depth) {
        wgpu::ColorTargetState target;
        target.format = wgpu::TextureFormat::RGBA8Unorm;
        wgpu::FragmentState fragment;
        fragment.module = module;
        fragment.entryPoint = "fs";
        fragment.targetCount = 1;
        fragment.targets = &target;
        wgpu::DepthStencilState depthState;
        depthState.format = wgpu::TextureFormat::Depth32Float;
        depthState.depthWriteEnabled = wgpu::OptionalBool::True;
        depthState.depthCompare = wgpu::CompareFunction::Less;
        wgpu::RenderPipelineDescriptor descriptor;
        descriptor.vertex.module = module;
        descriptor.vertex.entryPoint = "vs";
        descriptor.fragment = &fragment;
        descriptor.primitive.topology = wgpu::PrimitiveTopology::TriangleList;
        descriptor.primitive.cullMode = wgpu::CullMode::None;
        descriptor.depthStencil = depth ? &depthState : nullptr;
        return device.CreateRenderPipeline(&descriptor);
    }

    wgpu::BindGroup Bind(const wgpu::ComputePipeline& pipeline, std::vector<wgpu::Buffer> buffers) { return BindLayout(pipeline.GetBindGroupLayout(0), buffers); }
    wgpu::BindGroup BindLayout(const wgpu::BindGroupLayout& layout, const std::vector<wgpu::Buffer>& buffers) {
        std::vector<wgpu::BindGroupEntry> entries(buffers.size());
        for (size_t i = 0; i < buffers.size(); i++) {
            entries[i].binding = static_cast<uint32_t>(i);
            entries[i].buffer = buffers[i];
            entries[i].size = buffers[i].GetSize();
        }
        wgpu::BindGroupDescriptor descriptor;
        descriptor.layout = layout;
        descriptor.entryCount = entries.size();
        descriptor.entries = entries.data();
        return device.CreateBindGroup(&descriptor);
    }

    Encode Dispatch(const wgpu::ComputePipeline& pipeline, uint32_t x, uint32_t y, const wgpu::BindGroup& group) {
        return [=](wgpu::CommandEncoder& encoder, const wgpu::PassTimestampWrites* writes) {
            wgpu::ComputePassDescriptor descriptor;
            descriptor.timestampWrites = writes;
            wgpu::ComputePassEncoder pass = encoder.BeginComputePass(&descriptor);
            pass.SetPipeline(pipeline);
            pass.SetBindGroup(0, group);
            pass.DispatchWorkgroups(x, y, 1);
            pass.End();
        };
    }

    uint64_t LitPixels(const wgpu::Texture& texture) {
        const uint64_t size = uint64_t(kWidth) * kHeight * 4;
        wgpu::BufferDescriptor descriptor;
        descriptor.size = size;
        descriptor.usage = wgpu::BufferUsage::MapRead | wgpu::BufferUsage::CopyDst;
        wgpu::Buffer staging = device.CreateBuffer(&descriptor);
        wgpu::TexelCopyTextureInfo source;
        source.texture = texture;
        wgpu::TexelCopyBufferInfo destination;
        destination.buffer = staging;
        destination.layout.bytesPerRow = kWidth * 4;
        destination.layout.rowsPerImage = kHeight;
        wgpu::Extent3D extent{kWidth, kHeight, 1};
        wgpu::CommandEncoder encoder = device.CreateCommandEncoder();
        encoder.CopyTextureToBuffer(&source, &destination, &extent);
        wgpu::CommandBuffer commands = encoder.Finish();
        queue.Submit(1, &commands);
        const std::vector<uint8_t> bytes = MapRead(staging, size);
        staging.Destroy();
        uint64_t lit = 0;
        for (size_t i = 0; i < bytes.size(); i += 4) {
            if (!(bytes[i] == 0 && bytes[i + 1] == 0 && bytes[i + 2] == 0 && bytes[i + 3] == 255)) lit++;
        }
        return lit;
    }
};

std::string Format(double value) {
    char text[64];
    std::snprintf(text, sizeof text, "%.6f", value);
    return text;
}

}  // namespace

int main(int argc, char** argv) {
    std::string wgslDir, backend = "d3d12";
    std::set<std::string> only;
    for (int i = 1; i + 1 < argc; i += 2) {
        const std::string name = argv[i], value = argv[i + 1];
        if (name == "--wgsl") wgslDir = value;
        else if (name == "--backend") backend = value;
        else if (name == "--only") {
            std::stringstream list(value);
            for (std::string item; std::getline(list, item, ',');) only.insert(item);
        }
    }
    if (wgslDir.empty()) {
        std::fprintf(stderr, "--wgsl <dir> is required\n");
        return 2;
    }
    const auto wanted = [&](const std::string& name) { return only.empty() || only.count(name) > 0; };
    const auto source = [&](const std::string& name) { return ReadFile(wgslDir + "/" + name + ".wgsl"); };

    Bench bench;
    wgpu::InstanceFeatureName instanceFeature = wgpu::InstanceFeatureName::TimedWaitAny;
    wgpu::InstanceDescriptor instanceDescriptor;
    instanceDescriptor.requiredFeatureCount = 1;
    instanceDescriptor.requiredFeatures = &instanceFeature;
    bench.instance = wgpu::CreateInstance(&instanceDescriptor);

    wgpu::RequestAdapterOptions adapterOptions;
    adapterOptions.powerPreference = wgpu::PowerPreference::HighPerformance;
    adapterOptions.backendType = backend == "vulkan" ? wgpu::BackendType::Vulkan : wgpu::BackendType::D3D12;
    wgpu::Adapter adapter;
    bench.Wait(bench.instance.RequestAdapter(&adapterOptions, wgpu::CallbackMode::WaitAnyOnly, [&](wgpu::RequestAdapterStatus status, wgpu::Adapter result, wgpu::StringView message) {
        if (status == wgpu::RequestAdapterStatus::Success) adapter = std::move(result);
        else std::fprintf(stderr, "adapter: %.*s\n", int(message.length), message.data);
    }));
    if (!adapter) return 3;
    wgpu::AdapterInfo info;
    adapter.GetInfo(&info);
    bench.timestamps = adapter.HasFeature(wgpu::FeatureName::TimestampQuery);

    wgpu::Limits limits;
    limits.maxStorageBufferBindingSize = kStorageLimit;
    limits.maxBufferSize = kStorageLimit;
    wgpu::FeatureName feature = wgpu::FeatureName::TimestampQuery;
    wgpu::DeviceDescriptor deviceDescriptor;
    // Dawn quantizes timestamp queries by default (browser security); a benchmark needs the raw ticks.
    const char* disabledToggles[] = {"timestamp_quantization"};
    wgpu::DawnTogglesDescriptor toggles;
    toggles.disabledToggleCount = 1;
    toggles.disabledToggles = disabledToggles;
    deviceDescriptor.nextInChain = &toggles;
    deviceDescriptor.requiredLimits = &limits;
    deviceDescriptor.requiredFeatureCount = bench.timestamps ? 1 : 0;
    deviceDescriptor.requiredFeatures = &feature;
    gErrors = &bench.errors;
    deviceDescriptor.SetUncapturedErrorCallback([](const wgpu::Device&, wgpu::ErrorType, wgpu::StringView message) { gErrors->push_back(std::string(message.data, message.length)); });
    deviceDescriptor.SetDeviceLostCallback(wgpu::CallbackMode::AllowSpontaneous, [](const wgpu::Device&, wgpu::DeviceLostReason reason, wgpu::StringView message) {
        if (reason != wgpu::DeviceLostReason::Destroyed) gErrors->push_back("device lost: " + std::string(message.data, message.length));
    });
    bench.Wait(adapter.RequestDevice(&deviceDescriptor, wgpu::CallbackMode::WaitAnyOnly, [&](wgpu::RequestDeviceStatus status, wgpu::Device result, wgpu::StringView message) {
        if (status == wgpu::RequestDeviceStatus::Success) bench.device = std::move(result);
        else std::fprintf(stderr, "device: %.*s\n", int(message.length), message.data);
    }));
    if (!bench.device) return 4;
    bench.queue = bench.device.GetQueue();

    if (bench.timestamps) {
        wgpu::QuerySetDescriptor querySetDescriptor;
        querySetDescriptor.type = wgpu::QueryType::Timestamp;
        querySetDescriptor.count = 2;
        bench.querySet = bench.device.CreateQuerySet(&querySetDescriptor);
        wgpu::BufferDescriptor resolve;
        resolve.size = 16;
        resolve.usage = wgpu::BufferUsage::QueryResolve | wgpu::BufferUsage::CopySrc;
        bench.resolveBuffer = bench.device.CreateBuffer(&resolve);
        wgpu::BufferDescriptor read;
        read.size = 16;
        read.usage = wgpu::BufferUsage::MapRead | wgpu::BufferUsage::CopyDst;
        bench.readBuffer = bench.device.CreateBuffer(&read);
    }

    const std::string init = source("init"), vecadd = source("vecadd"), matinit = source("matinit"), matmul = source("matmul"), reduce1 = source("reduce1"),
                      reduce2 = source("reduce2"), cubes = source("cubes"), fullscreen = source("fullscreen");
    const uint64_t bytes = kElements * 4;

    if (wanted("vecadd") || wanted("reduce")) {
        wgpu::Buffer a = bench.Storage(bytes), b = bench.Storage(bytes), c = bench.Storage(bytes);
        wgpu::ComputePipeline initPipeline = bench.ComputePipelineOf(bench.Module(init));
        bench.Measure(bench.Dispatch(initPipeline, 512, 512, bench.Bind(initPipeline, {a, b})));

        if (wanted("vecadd")) {
            wgpu::ComputePipeline pipeline = bench.ComputePipelineOf(bench.Module(vecadd));
            const Encode encode = bench.Dispatch(pipeline, 512, 512, bench.Bind(pipeline, {a, b, c}));
            bench.Warm(encode);
            for (int i = 0; i < 50; i++) bench.Record("vecadd_64M", bench.Measure(encode));
            const auto head = bench.ReadBack(c, 0, 4096), tail = bench.ReadBack(c, bytes - 4096, 4096);
            bool ok = true;
            for (uint64_t i = 0; i < 1024; i++) {
                float h, t;
                std::memcpy(&h, head.data() + i * 4, 4);
                std::memcpy(&t, tail.data() + i * 4, 4);
                ok = ok && h == float((i & 1023) + 1) && t == float(((kElements - 1024 + i) & 1023) + 1);
            }
            bench.checks["vecadd_ok"] = ok ? "true" : "false";
        }
        if (wanted("reduce")) {
            wgpu::Buffer partials = bench.Storage(32768 * 4), result = bench.Storage(4);
            wgpu::ComputePipeline pass1 = bench.ComputePipelineOf(bench.Module(reduce1)), pass2 = bench.ComputePipelineOf(bench.Module(reduce2));
            wgpu::BindGroup group1 = bench.Bind(pass1, {b, partials}), group2 = bench.Bind(pass2, {partials, result});
            const Encode encode = [=](wgpu::CommandEncoder& encoder, const wgpu::PassTimestampWrites* writes) {
                wgpu::ComputePassDescriptor descriptor;
                descriptor.timestampWrites = writes;
                wgpu::ComputePassEncoder pass = encoder.BeginComputePass(&descriptor);
                pass.SetPipeline(pass1);
                pass.SetBindGroup(0, group1);
                pass.DispatchWorkgroups(32768, 1, 1);
                pass.SetPipeline(pass2);
                pass.SetBindGroup(0, group2);
                pass.DispatchWorkgroups(1, 1, 1);
                pass.End();
            };
            bench.Warm(encode);
            for (int i = 0; i < 100; i++) bench.Record("reduce_64M", bench.Measure(encode));
            float sum;
            const auto raw = bench.ReadBack(result, 0, 4);
            std::memcpy(&sum, raw.data(), 4);
            bench.checks["reduce_sum"] = Format(sum);
            bench.checks["reduce_ok"] = uint64_t(sum) == kElements ? "true" : "false";
        }
    }

    if (wanted("matmul")) {
        const uint64_t size = kMatrix * kMatrix * 4;
        wgpu::Buffer a = bench.Storage(size), b = bench.Storage(size), c = bench.Storage(size);
        wgpu::ComputePipeline initPipeline = bench.ComputePipelineOf(bench.Module(matinit));
        bench.Measure(bench.Dispatch(initPipeline, 128, 128, bench.Bind(initPipeline, {a, b})));
        wgpu::ComputePipeline pipeline = bench.ComputePipelineOf(bench.Module(matmul));
        const Encode encode = bench.Dispatch(pipeline, 128, 128, bench.Bind(pipeline, {a, b, c}));
        bench.Warm(encode);
        for (int i = 0; i < 50; i++) bench.Record("matmul_2048", bench.Measure(encode));
        const auto raw = bench.ReadBack(c, 0, size);
        const float* out = reinterpret_cast<const float*>(raw.data());
        bool ok = true;
        const uint64_t probes[5][2] = {{0, 0}, {1, 2047}, {1023, 1024}, {2047, 2047}, {700, 33}};
        for (const auto& probe : probes) {
            uint64_t sum = 0;
            for (uint64_t k = 0; k < kMatrix; k++) sum += ((probe[0] + 2 * k) % 5) * ((3 * k + probe[1]) % 7);
            ok = ok && out[probe[0] * kMatrix + probe[1]] == float(sum);
        }
        bench.checks["matmul_ok"] = ok ? "true" : "false";
    }

    wgpu::TextureDescriptor colorDescriptor;
    colorDescriptor.size = {kWidth, kHeight, 1};
    colorDescriptor.format = wgpu::TextureFormat::RGBA8Unorm;
    colorDescriptor.usage = wgpu::TextureUsage::RenderAttachment | wgpu::TextureUsage::CopySrc;
    colorDescriptor.dimension = wgpu::TextureDimension::e2D;
    wgpu::Texture color = bench.device.CreateTexture(&colorDescriptor);
    wgpu::TextureDescriptor depthDescriptor = colorDescriptor;
    depthDescriptor.format = wgpu::TextureFormat::Depth32Float;
    depthDescriptor.usage = wgpu::TextureUsage::RenderAttachment;
    wgpu::Texture depth = bench.device.CreateTexture(&depthDescriptor);
    wgpu::TextureView colorView = color.CreateView(), depthView = depth.CreateView();
    const auto draw = [&](const wgpu::RenderPipeline& pipeline, const wgpu::BindGroup& group, bool hasGroup, uint32_t vertices, uint32_t instances, bool withDepth) -> Encode {
        return [=](wgpu::CommandEncoder& encoder, const wgpu::PassTimestampWrites* writes) {
            wgpu::RenderPassColorAttachment attachment;
            attachment.view = colorView;
            attachment.loadOp = wgpu::LoadOp::Clear;
            attachment.storeOp = wgpu::StoreOp::Store;
            attachment.clearValue = {0, 0, 0, 1};
            wgpu::RenderPassDepthStencilAttachment depthAttachment;
            depthAttachment.view = depthView;
            depthAttachment.depthLoadOp = wgpu::LoadOp::Clear;
            depthAttachment.depthStoreOp = wgpu::StoreOp::Store;
            depthAttachment.depthClearValue = 1.0f;
            wgpu::RenderPassDescriptor descriptor;
            descriptor.colorAttachmentCount = 1;
            descriptor.colorAttachments = &attachment;
            descriptor.depthStencilAttachment = withDepth ? &depthAttachment : nullptr;
            descriptor.timestampWrites = writes;
            wgpu::RenderPassEncoder pass = encoder.BeginRenderPass(&descriptor);
            pass.SetPipeline(pipeline);
            if (hasGroup) pass.SetBindGroup(0, group);
            pass.Draw(vertices, instances);
            pass.End();
        };
    };

    if (wanted("cubes")) {
        std::vector<float> data(size_t(kInstances) * 4);
        for (uint32_t i = 0; i < kInstances; i++) {
            data[i * 4] = float((i % 100) * 3);
            data[i * 4 + 1] = float(((i / 100) % 100) * 3);
            data[i * 4 + 2] = float((i / 10000) * 3);
            data[i * 4 + 3] = 1.0f + float(i % 3) * 0.1f;
        }
        wgpu::Buffer instances = bench.Storage(data.size() * 4);
        bench.queue.WriteBuffer(instances, 0, data.data(), data.size() * 4);
        wgpu::RenderPipeline pipeline = bench.RenderPipelineOf(bench.Module(cubes), true);
        wgpu::BindGroup group = bench.BindLayout(pipeline.GetBindGroupLayout(0), {instances});
        const Encode encode = draw(pipeline, group, true, 36, kInstances, true);
        bench.Warm(encode);
        for (int i = 0; i < 200; i++) bench.Record("cubes_100k_1080p", bench.Measure(encode));
        bench.checks["cubes_lit_pixels"] = std::to_string(bench.LitPixels(color));
    }
    if (wanted("fullscreen")) {
        wgpu::RenderPipeline pipeline = bench.RenderPipelineOf(bench.Module(fullscreen), false);
        const Encode encode = draw(pipeline, wgpu::BindGroup(), false, 3, 1, false);
        bench.Warm(encode);
        for (int i = 0; i < 100; i++) bench.Record("fullscreen_1080p", bench.Measure(encode));
        bench.checks["fullscreen_lit_pixels"] = std::to_string(bench.LitPixels(color));
    }

    if (wanted("api")) {
        const std::vector<uint8_t> payload(65536, 0);
        for (int window = 0; window < 5; window++) {
            uint64_t operations = 0;
            const auto start = Clock::now();
            while (Ms(start) < 500.0) {
                wgpu::BufferDescriptor descriptor;
                descriptor.size = payload.size();
                descriptor.usage = wgpu::BufferUsage::CopyDst | wgpu::BufferUsage::Storage;
                wgpu::Buffer buffer = bench.device.CreateBuffer(&descriptor);
                bench.queue.WriteBuffer(buffer, 0, payload.data(), payload.size());
                wgpu::CommandEncoder encoder = bench.device.CreateCommandEncoder();
                encoder.ClearBuffer(buffer, 0, 256);
                wgpu::CommandBuffer commands = encoder.Finish();
                bench.queue.Submit(1, &commands);
                buffer.Destroy();
                operations++;
                if (operations % 256 == 0) bench.Drain();
            }
            bench.Drain();
            bench.Push("buffer_create_write_submit_per_s", double(operations) * 1000.0 / Ms(start));
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
        for (int i = -2; i < 20; i++) {
            const auto start = Clock::now();
            wgpu::ShaderModule module = bench.Module(Unique(matmul, i + 1000));
            bench.CompilationInfo(module);
            if (i >= 0) bench.Push("shader_module_ms", Ms(start));
        }
        for (int i = -2; i < 15; i++) {
            wgpu::ShaderModule module = bench.Module(Unique(cubes, i + 2000));
            bench.CompilationInfo(module);
            const auto start = Clock::now();
            wgpu::RenderPipeline pipeline = bench.RenderPipelineOf(module, true);
            if (i >= 0) bench.Push("render_pipeline_ms", Ms(start));
        }
        for (int i = -2; i < 15; i++) {
            wgpu::ShaderModule module = bench.Module(Unique(matmul, i + 3000));
            bench.CompilationInfo(module);
            const auto start = Clock::now();
            wgpu::ComputePipeline pipeline = bench.ComputePipelineOf(module);
            if (i >= 0) bench.Push("compute_pipeline_ms", Ms(start));
        }
    }

    bench.Drain();
    const auto text = [](wgpu::StringView view) { return Escape(std::string(view.data ? view.data : "", view.data ? view.length : 0)); };
    std::printf("{\"labels\":{\"host\":\"native\",\"engine\":\"dawn\",\"runtime\":\"dawn prebuilt static (C++)\",\"requestedBackend\":\"%s\",\"backend\":\"%s\"},", backend.c_str(),
                adapterOptions.backendType == wgpu::BackendType::Vulkan ? "Vulkan" : "D3D12");
    std::printf("\"adapter\":{\"vendor\":\"%s\",\"architecture\":\"%s\",\"device\":\"%s\",\"description\":\"%s\"},", text(info.vendor).c_str(), text(info.architecture).c_str(), text(info.device).c_str(), text(info.description).c_str());
    std::printf("\"features\":{\"timestampQuery\":%s},\"errors\":[", bench.timestamps ? "true" : "false");
    for (size_t i = 0; i < bench.errors.size(); i++) std::printf("%s\"%s\"", i ? "," : "", Escape(bench.errors[i]).c_str());
    std::printf("],\"metrics\":{");
    bool first = true;
    for (const auto& [name, values] : bench.metrics) {
        std::printf("%s\"%s\":[", first ? "" : ",", name.c_str());
        for (size_t i = 0; i < values.size(); i++) std::printf("%s%s", i ? "," : "", Format(values[i]).c_str());
        std::printf("]");
        first = false;
    }
    std::printf("},\"checks\":{");
    first = true;
    for (const auto& [name, value] : bench.checks) {
        const bool literal = value == "true" || value == "false" || (!value.empty() && std::all_of(value.begin(), value.end(), [](char c) { return (c >= '0' && c <= '9') || c == '.'; }));
        std::printf("%s\"%s\":%s%s%s", first ? "" : ",", name.c_str(), literal ? "" : "\"", value.c_str(), literal ? "" : "\"");
        first = false;
    }
    std::printf("}}\n");
    return 0;
}
