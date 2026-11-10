//
// Copyright 2020 Electronic Arts Inc.
//
// TiberianDawn.DLL and RedAlert.dll and corresponding source code is free
// software: you can redistribute it and/or modify it under the terms of
// the GNU General Public License as published by the Free Software Foundation,
// either version 3 of the License, or (at your option) any later version.
//
// TiberianDawn.DLL and RedAlert.dll and corresponding source code is distributed
// in the hope that it will be useful, but with permitted additional restrictions
// under Section 7 of the GPL. See the GNU General Public License in LICENSE.TXT
// distributed with this program.
//

#include "gbuffer.h"
#include "palette.h"
#include "video.h"
#include "wwkeyboard.h"
#include "wwmouse.h"
#include "settings.h"
#include "paths.h"
#include "debugstring.h"

#include <SDL.h>
#include <SDL_vulkan.h>
#include <vulkan/vulkan.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

extern WWKeyboardClass* Keyboard;

static SDL_Window* window = nullptr;
static SDL_Palette* palette = nullptr;
static SDL_Rect render_dst = {0, 0, 0, 0};
static int last_out_w = 0;
static int last_out_h = 0;

static struct
{
    int GameW{640};
    int GameH{400};
    bool Clip{false};
    float ScaleX{1.0f};
    float ScaleY{1.0f};
    void* Raw{nullptr};
    int W{0};
    int H{0};
    int HotX{0};
    int HotY{0};
    float X{0.0f};
    float Y{0.0f};
    SDL_Cursor* Pending{nullptr};
    SDL_Cursor* Current{nullptr};
    SDL_Surface* Surface{nullptr};
} hwcursor;

// Embedded SPIR-V for Pass 2 Software Framebuffer Fullscreen Quad (Vertex Shader)
static const uint32_t kFullscreenVertSpv[] = {
    0x07230203,0x00010000,0x000d000b,0x0000002f,
    0x00000000,0x00020011,0x00000001,0x0006000b,
    0x00000001,0x4c534c47,0x6474732e,0x3035342e,
    0x00000000,0x0003000e,0x00000000,0x00000001,
    0x0008000f,0x00000000,0x00000004,0x6e69616d,
    0x00000000,0x0000000c,0x00000018,0x00000020,
    0x00040047,0x0000000c,0x0000000b,0x0000002a,
    0x00040047,0x00000018,0x0000001e,0x00000000,
    0x00030047,0x0000001e,0x00000002,0x00050048,
    0x0000001e,0x00000000,0x0000000b,0x00000000,
    0x00050048,0x0000001e,0x00000001,0x0000000b,
    0x00000001,0x00050048,0x0000001e,0x00000002,
    0x0000000b,0x00000003,0x00050048,0x0000001e,
    0x00000003,0x0000000b,0x00000004,0x00020013,
    0x00000002,0x00030021,0x00000003,0x00000002,
    0x00030016,0x00000006,0x00000020,0x00040017,
    0x00000007,0x00000006,0x00000002,0x00040015,
    0x0000000a,0x00000020,0x00000001,0x00040020,
    0x0000000b,0x00000001,0x0000000a,0x0004003b,
    0x0000000b,0x0000000c,0x00000001,0x0004002b,
    0x0000000a,0x0000000e,0x00000001,0x0004002b,
    0x0000000a,0x00000010,0x00000002,0x00040020,
    0x00000017,0x00000003,0x00000007,0x0004003b,
    0x00000017,0x00000018,0x00000003,0x00040017,
    0x0000001a,0x00000006,0x00000004,0x00040015,
    0x0000001b,0x00000020,0x00000000,0x0004002b,
    0x0000001b,0x0000001c,0x00000001,0x0004001c,
    0x0000001d,0x00000006,0x0000001c,0x0006001e,
    0x0000001e,0x0000001a,0x00000006,0x0000001d,
    0x0000001d,0x00040020,0x0000001f,0x00000003,
    0x0000001e,0x0004003b,0x0000001f,0x00000020,
    0x00000003,0x0004002b,0x0000000a,0x00000021,
    0x00000000,0x0004002b,0x00000006,0x00000023,
    0x40000000,0x0004002b,0x00000006,0x00000025,
    0x3f800000,0x0004002b,0x00000006,0x00000028,
    0x00000000,0x00040020,0x0000002c,0x00000003,
    0x0000001a,0x0005002c,0x00000007,0x0000002e,
    0x00000025,0x00000025,0x00050036,0x00000002,
    0x00000004,0x00000000,0x00000003,0x000200f8,
    0x00000005,0x0004003d,0x0000000a,0x0000000d,
    0x0000000c,0x000500c4,0x0000000a,0x0000000f,
    0x0000000d,0x0000000e,0x000500c7,0x0000000a,
    0x00000011,0x0000000f,0x00000010,0x0004006f,
    0x00000006,0x00000012,0x00000011,0x000500c7,
    0x0000000a,0x00000014,0x0000000d,0x00000010,
    0x0004006f,0x00000006,0x00000015,0x00000014,
    0x00050050,0x00000007,0x00000016,0x00000012,
    0x00000015,0x0003003e,0x00000018,0x00000016,
    0x0005008e,0x00000007,0x00000024,0x00000016,
    0x00000023,0x00050083,0x00000007,0x00000027,
    0x00000024,0x0000002e,0x00050051,0x00000006,
    0x00000029,0x00000027,0x00000000,0x00050051,
    0x00000006,0x0000002a,0x00000027,0x00000001,
    0x00070050,0x0000001a,0x0000002b,0x00000029,
    0x0000002a,0x00000028,0x00000025,0x00050041,
    0x0000002c,0x0000002d,0x00000020,0x00000021,
    0x0003003e,0x0000002d,0x0000002b,0x000100fd,
    0x00010038
};

// Embedded SPIR-V for Pass 2 Software Framebuffer Palette Lookup (Fragment Shader)
static const uint32_t kPaletteFragSpv[] = {
    0x07230203,0x00010000,0x000d000b,0x0000002e,
    0x00000000,0x00020011,0x00000001,0x0006000b,
    0x00000001,0x4c534c47,0x6474732e,0x3035342e,
    0x00000000,0x0003000e,0x00000000,0x00000001,
    0x0007000f,0x00000004,0x00000004,0x6e69616d,
    0x00000000,0x00000011,0x0000001b,0x00030010,
    0x00000004,0x00000007,0x00040047,0x0000000c,
    0x00000021,0x00000000,0x00040047,0x0000000c,
    0x00000022,0x00000000,0x00040047,0x00000011,
    0x0000001e,0x00000000,0x00040047,0x0000001b,
    0x0000001e,0x00000000,0x00040047,0x0000001d,
    0x00000006,0x00000010,0x00030047,0x0000001e,
    0x00000002,0x00050048,0x0000001e,0x00000000,
    0x00000023,0x00000000,0x00040047,0x00000020,
    0x00000021,0x00000001,0x00040047,0x00000020,
    0x00000022,0x00000000,0x00020013,0x00000002,
    0x00030021,0x00000003,0x00000002,0x00040015,
    0x00000006,0x00000020,0x00000000,0x00090019,
    0x00000009,0x00000006,0x00000001,0x00000000,
    0x00000000,0x00000000,0x00000001,0x00000000,
    0x0003001b,0x0000000a,0x00000009,0x00040020,
    0x0000000b,0x00000000,0x0000000a,0x0004003b,
    0x0000000b,0x0000000c,0x00000000,0x00030016,
    0x0000000e,0x00000020,0x00040017,0x0000000f,
    0x0000000e,0x00000002,0x00040020,0x00000010,
    0x00000001,0x0000000f,0x0004003b,0x00000010,
    0x00000011,0x00000001,0x00040017,0x00000013,
    0x00000006,0x00000004,0x0004002b,0x00000006,
    0x00000017,0x000000ff,0x00040017,0x00000019,
    0x0000000e,0x00000004,0x00040020,0x0000001a,
    0x00000003,0x00000019,0x0004003b,0x0000001a,
    0x0000001b,0x00000003,0x0004002b,0x00000006,
    0x0000001c,0x00000100,0x0004001c,0x0000001d,
    0x00000019,0x0000001c,0x0003001e,0x0000001e,
    0x0000001d,0x00040020,0x0000001f,0x00000002,
    0x0000001e,0x0004003b,0x0000001f,0x00000020,
    0x00000002,0x00040015,0x00000021,0x00000020,
    0x00000001,0x0004002b,0x00000021,0x00000022,
    0x00000000,0x00040020,0x00000025,0x00000002,
    0x00000019,0x0004002b,0x0000000e,0x00000029,
    0x3f800000,0x00050036,0x00000002,0x00000004,
    0x00000000,0x00000003,0x000200f8,0x00000005,
    0x0004003d,0x0000000a,0x0000000d,0x0000000c,
    0x0004003d,0x0000000f,0x00000012,0x00000011,
    0x00050057,0x00000013,0x00000014,0x0000000d,
    0x00000012,0x00050051,0x00000006,0x00000016,
    0x00000014,0x00000000,0x000500c7,0x00000006,
    0x00000018,0x00000016,0x00000017,0x00060041,
    0x00000025,0x00000026,0x00000020,0x00000022,
    0x00000018,0x0004003d,0x00000019,0x00000027,
    0x00000026,0x00050051,0x0000000e,0x0000002a,
    0x00000027,0x00000000,0x00050051,0x0000000e,
    0x0000002b,0x00000027,0x00000001,0x00050051,
    0x0000000e,0x0000002c,0x00000027,0x00000002,
    0x00070050,0x00000019,0x0000002d,0x0000002a,
    0x0000002b,0x0000002c,0x00000029,0x0003003e,
    0x0000001b,0x0000002d,0x000100fd,0x00010038
};

// Embedded SPIR-V for Native-4K Ultra Menu PBR + Particle + CRT Shader
static const uint32_t kUltraMenuFragSpv[] = {
#include "shaders/ultra_menu_frag_spv.inc"
};

// Embedded SPIR-V for Native-4K 3D Tactical Battlefield Shader
static const uint32_t kTactical3DFragSpv[] = {
#include "shaders/tactical_3d_frag_spv.inc"
};

/*=========================================================================*/
/* Vulkan 1.3 Presentation State & Double-Buffered Staging Ring            */
/*=========================================================================*/
static constexpr uint32_t kMaxFramesInFlight = 2;

struct PaletteUBOData
{
    float colors[256][4];
};

struct UltraMenuUBOData
{
    float params0[4];          // x=time_sec, y=mouse_u, z=mouse_v, w=aspect
    float params1[4];          // x=btn_count, y=cursor_visible, z=mouse_down, w=intro_fade
    float btn_rect[8][4];      // u0, v0, u1, v1
    float btn_state[8][4];     // hover_anim, selected, pressed, char_len
    uint32_t btn_chars[16][4]; // 32 ASCII bytes per button (2 uvec4s each)
    uint32_t ver_chars[2][4];  // 32 ASCII bytes for VersionText
    float ver_info[4];         // x=ver_len, y=reserved, z=reserved, w=reserved
};

struct UltraMenuRuntimeState
{
    bool active{false};
    UltraMenuUBOData ubo{};
    float smoothHover[8]{};
    std::chrono::steady_clock::time_point startTime{std::chrono::steady_clock::now()};
};

static UltraMenuRuntimeState ultraMenuState;

struct Tactical3DRuntimeState
{
    bool active{false};
    Tactical3DUBOData ubo{};
    float dialogRect[4]{0.0f, 0.0f, -1.0f, -1.0f};
    std::chrono::steady_clock::time_point startTime{std::chrono::steady_clock::now()};
};

static Tactical3DRuntimeState tactical3DState;

struct VulkanFrameResources
{
    VkCommandPool commandPool{VK_NULL_HANDLE};
    VkCommandBuffer commandBuffer{VK_NULL_HANDLE};
    VkSemaphore imageAcquiredSemaphore{VK_NULL_HANDLE};
    VkBuffer stagingBuffer{VK_NULL_HANDLE};
    VkDeviceMemory stagingMemory{VK_NULL_HANDLE};
    void* stagingMapped{nullptr};
    VkDeviceSize stagingCapacity{0};
    VkBuffer paletteBuffer{VK_NULL_HANDLE};
    VkDeviceMemory paletteMemory{VK_NULL_HANDLE};
    void* paletteMapped{nullptr};
    VkBuffer menuUboBuffer{VK_NULL_HANDLE};
    VkDeviceMemory menuUboMemory{VK_NULL_HANDLE};
    void* menuUboMapped{nullptr};
    VkBuffer tacticalUboBuffer{VK_NULL_HANDLE};
    VkDeviceMemory tacticalUboMemory{VK_NULL_HANDLE};
    void* tacticalUboMapped{nullptr};
    VkDescriptorSet descriptorSet{VK_NULL_HANDLE};
};

struct VulkanBackendContext
{
    bool initialized{false};
    VkInstance instance{VK_NULL_HANDLE};
    VkSurfaceKHR surface{VK_NULL_HANDLE};
    VkPhysicalDevice physicalDevice{VK_NULL_HANDLE};
    VkDevice device{VK_NULL_HANDLE};
    uint32_t graphicsQueueFamily{0};
    VkQueue graphicsQueue{VK_NULL_HANDLE};

    VkSwapchainKHR swapchain{VK_NULL_HANDLE};
    VkFormat swapchainFormat{VK_FORMAT_B8G8R8A8_UNORM};
    uint32_t swapchainWidth{0};
    uint32_t swapchainHeight{0};
    std::vector<VkImage> swapchainImages;
    std::vector<VkImageView> swapchainImageViews;
    std::vector<VkSemaphore> renderCompleteSemaphores;

    // Pass 1 (3D Scene) Depth Buffer Attachment
    VkFormat depthFormat{VK_FORMAT_D32_SFLOAT};
    VkImage depthImage{VK_NULL_HANDLE};
    VkDeviceMemory depthMemory{VK_NULL_HANDLE};
    VkImageView depthImageView{VK_NULL_HANDLE};

    // Pass 2 (Software Framebuffer) 8-bit Indexed GPU Texture & Sampler
    uint32_t fbWidth{0};
    uint32_t fbHeight{0};
    VkImage fbImage{VK_NULL_HANDLE};
    VkDeviceMemory fbMemory{VK_NULL_HANDLE};
    VkImageView fbImageView{VK_NULL_HANDLE};
    VkSampler fbSampler{VK_NULL_HANDLE};
    bool fbLayoutInitialized{false};

    // Ultra Menu 4K RGBA Texture & Linear Sampler
    bool menuTexLoaded{false};
    uint32_t menuTexWidth{0};
    uint32_t menuTexHeight{0};
    VkImage menuImage{VK_NULL_HANDLE};
    VkDeviceMemory menuMemory{VK_NULL_HANDLE};
    VkImageView menuImageView{VK_NULL_HANDLE};
    VkSampler menuSampler{VK_NULL_HANDLE};

    // Descriptors & Graphics Pipelines
    VkDescriptorSetLayout descriptorSetLayout{VK_NULL_HANDLE};
    VkDescriptorPool descriptorPool{VK_NULL_HANDLE};
    VkPipelineLayout pipelineLayout{VK_NULL_HANDLE};
    VkShaderModule vertShader{VK_NULL_HANDLE};
    VkShaderModule fragShader{VK_NULL_HANDLE};
    VkShaderModule ultraMenuFragShader{VK_NULL_HANDLE};
    VkShaderModule tactical3DFragShader{VK_NULL_HANDLE};
    VkPipeline presentPipeline{VK_NULL_HANDLE};
    VkPipeline ultraMenuPipeline{VK_NULL_HANDLE};
    VkPipeline tactical3DPipeline{VK_NULL_HANDLE};

    // Synchronization & Frame Ring
    VkSemaphore timelineSemaphore{VK_NULL_HANDLE};
    uint64_t frameIndex{0};
    uint64_t nextSignalValue{kMaxFramesInFlight + 1};
    bool requireSwapchainRecreate{false};
    VulkanFrameResources frames[kMaxFramesInFlight];

    // Active 256-color palette (normalized float RGBA for GPU UBO)
    PaletteUBOData currentPalette{};
};

static VulkanBackendContext vkCtx;

static void Update_HWCursor();
static void Update_HWCursor_Settings();

/*=========================================================================*/
/* Vulkan Memory & Resource Helpers                                        */
/*=========================================================================*/
static uint32_t Find_Memory_Type(uint32_t typeFilter, VkMemoryPropertyFlags properties)
{
    VkPhysicalDeviceMemoryProperties memProps{};
    vkGetPhysicalDeviceMemoryProperties(vkCtx.physicalDevice, &memProps);
    for (uint32_t i = 0; i < memProps.memoryTypeCount; ++i) {
        if ((typeFilter & (1u << i)) && (memProps.memoryTypes[i].propertyFlags & properties) == properties) {
            return i;
        }
    }
    return UINT32_MAX;
}

static bool Create_Buffer(VkDeviceSize size,
                          VkBufferUsageFlags usage,
                          VkMemoryPropertyFlags properties,
                          VkBuffer& outBuffer,
                          VkDeviceMemory& outMemory,
                          void** outMapped = nullptr)
{
    VkBufferCreateInfo bufInfo{};
    bufInfo.sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO;
    bufInfo.size = size;
    bufInfo.usage = usage;
    bufInfo.sharingMode = VK_SHARING_MODE_EXCLUSIVE;

    if (vkCreateBuffer(vkCtx.device, &bufInfo, nullptr, &outBuffer) != VK_SUCCESS) {
        return false;
    }

    VkMemoryRequirements memReqs{};
    vkGetBufferMemoryRequirements(vkCtx.device, outBuffer, &memReqs);

    uint32_t memType = Find_Memory_Type(memReqs.memoryTypeBits, properties);
    if (memType == UINT32_MAX) {
        vkDestroyBuffer(vkCtx.device, outBuffer, nullptr);
        outBuffer = VK_NULL_HANDLE;
        return false;
    }

    VkMemoryAllocateInfo allocInfo{};
    allocInfo.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO;
    allocInfo.allocationSize = memReqs.size;
    allocInfo.memoryTypeIndex = memType;

    if (vkAllocateMemory(vkCtx.device, &allocInfo, nullptr, &outMemory) != VK_SUCCESS) {
        vkDestroyBuffer(vkCtx.device, outBuffer, nullptr);
        outBuffer = VK_NULL_HANDLE;
        return false;
    }

    vkBindBufferMemory(vkCtx.device, outBuffer, outMemory, 0);

    if (outMapped) {
        if (vkMapMemory(vkCtx.device, outMemory, 0, size, 0, outMapped) != VK_SUCCESS) {
            *outMapped = nullptr;
        }
    }
    return true;
}

static void Destroy_Menu_Texture()
{
    if (!vkCtx.device) return;
    if (vkCtx.menuImageView) {
        vkDestroyImageView(vkCtx.device, vkCtx.menuImageView, nullptr);
        vkCtx.menuImageView = VK_NULL_HANDLE;
    }
    if (vkCtx.menuImage) {
        vkDestroyImage(vkCtx.device, vkCtx.menuImage, nullptr);
        vkCtx.menuImage = VK_NULL_HANDLE;
    }
    if (vkCtx.menuMemory) {
        vkFreeMemory(vkCtx.device, vkCtx.menuMemory, nullptr);
        vkCtx.menuMemory = VK_NULL_HANDLE;
    }
    vkCtx.menuTexLoaded = false;
    vkCtx.menuTexWidth = 0;
    vkCtx.menuTexHeight = 0;
}

static bool Ensure_Menu_Texture()
{
    if (!vkCtx.initialized) return false;
    if (vkCtx.menuImageView != VK_NULL_HANDLE) return true;

    std::vector<std::string> candidates;
    if (Paths.Data_Path() && Paths.Data_Path()[0] != '\0') {
        candidates.push_back(std::string(Paths.Data_Path()) + "/menu_ultra.rgba");
    }
    candidates.push_back("share/vanillatd/menu_ultra.rgba");
    candidates.push_back("../share/vanillatd/menu_ultra.rgba");
    candidates.push_back("/home/dt/src/ext/Vanilla-Conquer/share/vanillatd/menu_ultra.rgba");

    FILE* fp = nullptr;
    for (const auto& path : candidates) {
        fp = std::fopen(path.c_str(), "rb");
        if (fp) break;
    }

    uint32_t texW = 1, texH = 1;
    std::vector<uint8_t> pixels(4, 0);
    bool loadedRealAsset = false;

    if (fp) {
        uint32_t hdr[4]{};
        if (std::fread(hdr, sizeof(uint32_t), 4, fp) == 4 && hdr[0] == 0x554D4343u && hdr[1] > 0 && hdr[2] > 0) {
            texW = hdr[1];
            texH = hdr[2];
            size_t totalBytes = static_cast<size_t>(texW) * static_cast<size_t>(texH) * 4u;
            pixels.resize(totalBytes);
            if (std::fread(pixels.data(), 1, totalBytes, fp) == totalBytes) {
                loadedRealAsset = true;
            } else {
                texW = 1;
                texH = 1;
                pixels.assign(4, 0);
            }
        }
        std::fclose(fp);
    }

    VkImageCreateInfo imgInfo{};
    imgInfo.sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO;
    imgInfo.imageType = VK_IMAGE_TYPE_2D;
    imgInfo.format = VK_FORMAT_R8G8B8A8_UNORM;
    imgInfo.extent.width = texW;
    imgInfo.extent.height = texH;
    imgInfo.extent.depth = 1;
    imgInfo.mipLevels = 1;
    imgInfo.arrayLayers = 1;
    imgInfo.samples = VK_SAMPLE_COUNT_1_BIT;
    imgInfo.tiling = VK_IMAGE_TILING_OPTIMAL;
    imgInfo.usage = VK_IMAGE_USAGE_TRANSFER_DST_BIT | VK_IMAGE_USAGE_SAMPLED_BIT;
    imgInfo.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
    imgInfo.initialLayout = VK_IMAGE_LAYOUT_UNDEFINED;

    if (vkCreateImage(vkCtx.device, &imgInfo, nullptr, &vkCtx.menuImage) != VK_SUCCESS) {
        return false;
    }

    VkMemoryRequirements memReqs{};
    vkGetImageMemoryRequirements(vkCtx.device, vkCtx.menuImage, &memReqs);

    VkMemoryAllocateInfo allocInfo{};
    allocInfo.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO;
    allocInfo.allocationSize = memReqs.size;
    allocInfo.memoryTypeIndex = Find_Memory_Type(memReqs.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);

    if (allocInfo.memoryTypeIndex == UINT32_MAX ||
        vkAllocateMemory(vkCtx.device, &allocInfo, nullptr, &vkCtx.menuMemory) != VK_SUCCESS) {
        Destroy_Menu_Texture();
        return false;
    }

    vkBindImageMemory(vkCtx.device, vkCtx.menuImage, vkCtx.menuMemory, 0);

    VkImageViewCreateInfo viewInfo{};
    viewInfo.sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO;
    viewInfo.image = vkCtx.menuImage;
    viewInfo.viewType = VK_IMAGE_VIEW_TYPE_2D;
    viewInfo.format = VK_FORMAT_R8G8B8A8_UNORM;
    viewInfo.subresourceRange.aspectMask = VK_IMAGE_ASPECT_COLOR_BIT;
    viewInfo.subresourceRange.baseMipLevel = 0;
    viewInfo.subresourceRange.levelCount = 1;
    viewInfo.subresourceRange.baseArrayLayer = 0;
    viewInfo.subresourceRange.layerCount = 1;

    if (vkCreateImageView(vkCtx.device, &viewInfo, nullptr, &vkCtx.menuImageView) != VK_SUCCESS) {
        Destroy_Menu_Texture();
        return false;
    }

    // Upload pixel data via one-shot staging buffer
    VkBuffer uploadBuf = VK_NULL_HANDLE;
    VkDeviceMemory uploadMem = VK_NULL_HANDLE;
    void* uploadMapped = nullptr;
    if (!Create_Buffer(pixels.size(),
                       VK_BUFFER_USAGE_TRANSFER_SRC_BIT,
                       VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT,
                       uploadBuf,
                       uploadMem,
                       &uploadMapped)) {
        Destroy_Menu_Texture();
        return false;
    }
    std::memcpy(uploadMapped, pixels.data(), pixels.size());
    vkUnmapMemory(vkCtx.device, uploadMem);

    VkCommandBuffer cmd = vkCtx.frames[0].commandBuffer;
    vkResetCommandPool(vkCtx.device, vkCtx.frames[0].commandPool, 0);

    VkCommandBufferBeginInfo beginInfo{};
    beginInfo.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO;
    beginInfo.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
    vkBeginCommandBuffer(cmd, &beginInfo);

    VkImageMemoryBarrier2 toTransfer{};
    toTransfer.sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER_2;
    toTransfer.srcStageMask = VK_PIPELINE_STAGE_2_NONE;
    toTransfer.srcAccessMask = 0;
    toTransfer.dstStageMask = VK_PIPELINE_STAGE_2_TRANSFER_BIT;
    toTransfer.dstAccessMask = VK_ACCESS_2_TRANSFER_WRITE_BIT;
    toTransfer.oldLayout = VK_IMAGE_LAYOUT_UNDEFINED;
    toTransfer.newLayout = VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL;
    toTransfer.image = vkCtx.menuImage;
    toTransfer.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};

    VkDependencyInfo dep1{};
    dep1.sType = VK_STRUCTURE_TYPE_DEPENDENCY_INFO;
    dep1.imageMemoryBarrierCount = 1;
    dep1.pImageMemoryBarriers = &toTransfer;
    vkCmdPipelineBarrier2(cmd, &dep1);

    VkBufferImageCopy copyRegion{};
    copyRegion.imageSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1};
    copyRegion.imageExtent = {texW, texH, 1};
    vkCmdCopyBufferToImage(cmd, uploadBuf, vkCtx.menuImage, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1, &copyRegion);

    VkImageMemoryBarrier2 toShader{};
    toShader.sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER_2;
    toShader.srcStageMask = VK_PIPELINE_STAGE_2_TRANSFER_BIT;
    toShader.srcAccessMask = VK_ACCESS_2_TRANSFER_WRITE_BIT;
    toShader.dstStageMask = VK_PIPELINE_STAGE_2_FRAGMENT_SHADER_BIT;
    toShader.dstAccessMask = VK_ACCESS_2_SHADER_SAMPLED_READ_BIT;
    toShader.oldLayout = VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL;
    toShader.newLayout = VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL;
    toShader.image = vkCtx.menuImage;
    toShader.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};

    VkDependencyInfo dep2{};
    dep2.sType = VK_STRUCTURE_TYPE_DEPENDENCY_INFO;
    dep2.imageMemoryBarrierCount = 1;
    dep2.pImageMemoryBarriers = &toShader;
    vkCmdPipelineBarrier2(cmd, &dep2);

    vkEndCommandBuffer(cmd);

    VkSubmitInfo submit{};
    submit.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO;
    submit.commandBufferCount = 1;
    submit.pCommandBuffers = &cmd;
    vkQueueSubmit(vkCtx.graphicsQueue, 1, &submit, VK_NULL_HANDLE);
    vkQueueWaitIdle(vkCtx.graphicsQueue);

    vkDestroyBuffer(vkCtx.device, uploadBuf, nullptr);
    vkFreeMemory(vkCtx.device, uploadMem, nullptr);

    vkCtx.menuTexLoaded = loadedRealAsset;
    vkCtx.menuTexWidth = texW;
    vkCtx.menuTexHeight = texH;
    return true;
}

static void Destroy_Framebuffer_Texture()
{
    if (!vkCtx.device) return;
    if (vkCtx.fbImageView) {
        vkDestroyImageView(vkCtx.device, vkCtx.fbImageView, nullptr);
        vkCtx.fbImageView = VK_NULL_HANDLE;
    }
    if (vkCtx.fbImage) {
        vkDestroyImage(vkCtx.device, vkCtx.fbImage, nullptr);
        vkCtx.fbImage = VK_NULL_HANDLE;
    }
    if (vkCtx.fbMemory) {
        vkFreeMemory(vkCtx.device, vkCtx.fbMemory, nullptr);
        vkCtx.fbMemory = VK_NULL_HANDLE;
    }
    vkCtx.fbWidth = 0;
    vkCtx.fbHeight = 0;
    vkCtx.fbLayoutInitialized = false;
}

static bool Ensure_Framebuffer_Texture(uint32_t w, uint32_t h)
{
    if (!vkCtx.initialized || w == 0 || h == 0) return false;
    if (vkCtx.fbImage != VK_NULL_HANDLE && vkCtx.fbWidth == w && vkCtx.fbHeight == h) {
        return true;
    }

    vkDeviceWaitIdle(vkCtx.device);
    Destroy_Framebuffer_Texture();

    VkImageCreateInfo imgInfo{};
    imgInfo.sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO;
    imgInfo.imageType = VK_IMAGE_TYPE_2D;
    imgInfo.format = VK_FORMAT_R8_UINT;
    imgInfo.extent.width = w;
    imgInfo.extent.height = h;
    imgInfo.extent.depth = 1;
    imgInfo.mipLevels = 1;
    imgInfo.arrayLayers = 1;
    imgInfo.samples = VK_SAMPLE_COUNT_1_BIT;
    imgInfo.tiling = VK_IMAGE_TILING_OPTIMAL;
    imgInfo.usage = VK_IMAGE_USAGE_TRANSFER_DST_BIT | VK_IMAGE_USAGE_SAMPLED_BIT;
    imgInfo.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
    imgInfo.initialLayout = VK_IMAGE_LAYOUT_UNDEFINED;

    if (vkCreateImage(vkCtx.device, &imgInfo, nullptr, &vkCtx.fbImage) != VK_SUCCESS) {
        return false;
    }

    VkMemoryRequirements memReqs{};
    vkGetImageMemoryRequirements(vkCtx.device, vkCtx.fbImage, &memReqs);

    VkMemoryAllocateInfo allocInfo{};
    allocInfo.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO;
    allocInfo.allocationSize = memReqs.size;
    allocInfo.memoryTypeIndex = Find_Memory_Type(memReqs.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);

    if (allocInfo.memoryTypeIndex == UINT32_MAX ||
        vkAllocateMemory(vkCtx.device, &allocInfo, nullptr, &vkCtx.fbMemory) != VK_SUCCESS) {
        Destroy_Framebuffer_Texture();
        return false;
    }

    vkBindImageMemory(vkCtx.device, vkCtx.fbImage, vkCtx.fbMemory, 0);

    VkImageViewCreateInfo viewInfo{};
    viewInfo.sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO;
    viewInfo.image = vkCtx.fbImage;
    viewInfo.viewType = VK_IMAGE_VIEW_TYPE_2D;
    viewInfo.format = VK_FORMAT_R8_UINT;
    viewInfo.subresourceRange.aspectMask = VK_IMAGE_ASPECT_COLOR_BIT;
    viewInfo.subresourceRange.baseMipLevel = 0;
    viewInfo.subresourceRange.levelCount = 1;
    viewInfo.subresourceRange.baseArrayLayer = 0;
    viewInfo.subresourceRange.layerCount = 1;

    if (vkCreateImageView(vkCtx.device, &viewInfo, nullptr, &vkCtx.fbImageView) != VK_SUCCESS) {
        Destroy_Framebuffer_Texture();
        return false;
    }

    vkCtx.fbWidth = w;
    vkCtx.fbHeight = h;
    vkCtx.fbLayoutInitialized = false;

    // Ensure staging buffers are large enough for w * h bytes and update descriptors
    VkDeviceSize requiredBytes = static_cast<VkDeviceSize>(w) * static_cast<VkDeviceSize>(h);
    for (uint32_t i = 0; i < kMaxFramesInFlight; ++i) {
        VulkanFrameResources& fr = vkCtx.frames[i];
        if (fr.stagingCapacity < requiredBytes) {
            if (fr.stagingMapped) {
                vkUnmapMemory(vkCtx.device, fr.stagingMemory);
                fr.stagingMapped = nullptr;
            }
            if (fr.stagingBuffer) {
                vkDestroyBuffer(vkCtx.device, fr.stagingBuffer, nullptr);
                fr.stagingBuffer = VK_NULL_HANDLE;
            }
            if (fr.stagingMemory) {
                vkFreeMemory(vkCtx.device, fr.stagingMemory, nullptr);
                fr.stagingMemory = VK_NULL_HANDLE;
            }
            Create_Buffer(requiredBytes,
                          VK_BUFFER_USAGE_TRANSFER_SRC_BIT,
                          VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT,
                          fr.stagingBuffer,
                          fr.stagingMemory,
                          &fr.stagingMapped);
            fr.stagingCapacity = requiredBytes;
        }

        VkDescriptorImageInfo imgDesc{};
        imgDesc.sampler = vkCtx.fbSampler;
        imgDesc.imageView = vkCtx.fbImageView;
        imgDesc.imageLayout = VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL;

        VkDescriptorBufferInfo palDesc{};
        palDesc.buffer = fr.paletteBuffer;
        palDesc.offset = 0;
        palDesc.range = sizeof(PaletteUBOData);

        VkDescriptorImageInfo menuImgDesc{};
        menuImgDesc.sampler = vkCtx.menuSampler ? vkCtx.menuSampler : vkCtx.fbSampler;
        menuImgDesc.imageView = vkCtx.menuImageView ? vkCtx.menuImageView : vkCtx.fbImageView;
        menuImgDesc.imageLayout = VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL;

        VkDescriptorBufferInfo menuUboDesc{};
        menuUboDesc.buffer = fr.menuUboBuffer;
        menuUboDesc.offset = 0;
        menuUboDesc.range = sizeof(UltraMenuUBOData);

        VkDescriptorBufferInfo tacUboDesc{};
        tacUboDesc.buffer = fr.tacticalUboBuffer;
        tacUboDesc.offset = 0;
        tacUboDesc.range = sizeof(Tactical3DUBOData);

        VkWriteDescriptorSet writes[5]{};
        writes[0].sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET;
        writes[0].dstSet = fr.descriptorSet;
        writes[0].dstBinding = 0;
        writes[0].descriptorCount = 1;
        writes[0].descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER;
        writes[0].pImageInfo = &imgDesc;

        writes[1].sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET;
        writes[1].dstSet = fr.descriptorSet;
        writes[1].dstBinding = 1;
        writes[1].descriptorCount = 1;
        writes[1].descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER;
        writes[1].pBufferInfo = &palDesc;

        writes[2].sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET;
        writes[2].dstSet = fr.descriptorSet;
        writes[2].dstBinding = 2;
        writes[2].descriptorCount = 1;
        writes[2].descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER;
        writes[2].pImageInfo = &menuImgDesc;

        writes[3].sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET;
        writes[3].dstSet = fr.descriptorSet;
        writes[3].dstBinding = 3;
        writes[3].descriptorCount = 1;
        writes[3].descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER;
        writes[3].pBufferInfo = &menuUboDesc;

        writes[4].sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET;
        writes[4].dstSet = fr.descriptorSet;
        writes[4].dstBinding = 4;
        writes[4].descriptorCount = 1;
        writes[4].descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER;
        writes[4].pBufferInfo = &tacUboDesc;

        vkUpdateDescriptorSets(vkCtx.device, 5, writes, 0, nullptr);
    }

    return true;
}

static void Destroy_Swapchain()
{
    if (!vkCtx.device) return;

    if (vkCtx.depthImageView) {
        vkDestroyImageView(vkCtx.device, vkCtx.depthImageView, nullptr);
        vkCtx.depthImageView = VK_NULL_HANDLE;
    }
    if (vkCtx.depthImage) {
        vkDestroyImage(vkCtx.device, vkCtx.depthImage, nullptr);
        vkCtx.depthImage = VK_NULL_HANDLE;
    }
    if (vkCtx.depthMemory) {
        vkFreeMemory(vkCtx.device, vkCtx.depthMemory, nullptr);
        vkCtx.depthMemory = VK_NULL_HANDLE;
    }

    for (VkSemaphore sem : vkCtx.renderCompleteSemaphores) {
        if (sem) vkDestroySemaphore(vkCtx.device, sem, nullptr);
    }
    vkCtx.renderCompleteSemaphores.clear();

    for (VkImageView view : vkCtx.swapchainImageViews) {
        if (view) vkDestroyImageView(vkCtx.device, view, nullptr);
    }
    vkCtx.swapchainImageViews.clear();
    vkCtx.swapchainImages.clear();

    if (vkCtx.swapchain) {
        vkDestroySwapchainKHR(vkCtx.device, vkCtx.swapchain, nullptr);
        vkCtx.swapchain = VK_NULL_HANDLE;
    }
}

static bool Create_Swapchain(uint32_t reqWidth, uint32_t reqHeight)
{
    VkSurfaceCapabilitiesKHR caps{};
    if (vkGetPhysicalDeviceSurfaceCapabilitiesKHR(vkCtx.physicalDevice, vkCtx.surface, &caps) != VK_SUCCESS) {
        return false;
    }

    uint32_t formatCount = 0;
    vkGetPhysicalDeviceSurfaceFormatsKHR(vkCtx.physicalDevice, vkCtx.surface, &formatCount, nullptr);
    if (formatCount == 0) return false;
    std::vector<VkSurfaceFormatKHR> formats(formatCount);
    vkGetPhysicalDeviceSurfaceFormatsKHR(vkCtx.physicalDevice, vkCtx.surface, &formatCount, formats.data());

    // Prefer UNORM format so 6-bit->8-bit VGA colors are presented directly without double gamma curve
    VkSurfaceFormatKHR chosenFormat = formats[0];
    for (const auto& fmt : formats) {
        if ((fmt.format == VK_FORMAT_B8G8R8A8_UNORM || fmt.format == VK_FORMAT_R8G8B8A8_UNORM) &&
            fmt.colorSpace == VK_COLOR_SPACE_SRGB_NONLINEAR_KHR) {
            chosenFormat = fmt;
            break;
        }
    }
    vkCtx.swapchainFormat = chosenFormat.format;

    VkExtent2D extent{};
    if (caps.currentExtent.width != UINT32_MAX) {
        extent = caps.currentExtent;
    } else {
        extent.width = std::max(caps.minImageExtent.width, std::min(reqWidth, caps.maxImageExtent.width));
        extent.height = std::max(caps.minImageExtent.height, std::min(reqHeight, caps.maxImageExtent.height));
    }

    if (extent.width == 0 || extent.height == 0) {
        return false;
    }

    uint32_t imageCount = caps.minImageCount + 1;
    if (caps.maxImageCount > 0 && imageCount > caps.maxImageCount) {
        imageCount = caps.maxImageCount;
    }

    VkSwapchainCreateInfoKHR scInfo{};
    scInfo.sType = VK_STRUCTURE_TYPE_SWAPCHAIN_CREATE_INFO_KHR;
    scInfo.surface = vkCtx.surface;
    scInfo.minImageCount = imageCount;
    scInfo.imageFormat = chosenFormat.format;
    scInfo.imageColorSpace = chosenFormat.colorSpace;
    scInfo.imageExtent = extent;
    scInfo.imageArrayLayers = 1;
    scInfo.imageUsage = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT |
                        (caps.supportedUsageFlags & VK_IMAGE_USAGE_TRANSFER_SRC_BIT);
    scInfo.imageSharingMode = VK_SHARING_MODE_EXCLUSIVE;
    scInfo.preTransform = caps.currentTransform;
    scInfo.compositeAlpha = VK_COMPOSITE_ALPHA_OPAQUE_BIT_KHR;
    scInfo.presentMode = VK_PRESENT_MODE_FIFO_KHR;
    scInfo.clipped = VK_TRUE;
    scInfo.oldSwapchain = VK_NULL_HANDLE;

    if (vkCreateSwapchainKHR(vkCtx.device, &scInfo, nullptr, &vkCtx.swapchain) != VK_SUCCESS) {
        return false;
    }

    vkCtx.swapchainWidth = extent.width;
    vkCtx.swapchainHeight = extent.height;

    uint32_t actualImages = 0;
    vkGetSwapchainImagesKHR(vkCtx.device, vkCtx.swapchain, &actualImages, nullptr);
    vkCtx.swapchainImages.resize(actualImages);
    vkGetSwapchainImagesKHR(vkCtx.device, vkCtx.swapchain, &actualImages, vkCtx.swapchainImages.data());

    vkCtx.swapchainImageViews.resize(actualImages, VK_NULL_HANDLE);
    vkCtx.renderCompleteSemaphores.resize(actualImages, VK_NULL_HANDLE);

    for (uint32_t i = 0; i < actualImages; ++i) {
        VkImageViewCreateInfo viewInfo{};
        viewInfo.sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO;
        viewInfo.image = vkCtx.swapchainImages[i];
        viewInfo.viewType = VK_IMAGE_VIEW_TYPE_2D;
        viewInfo.format = vkCtx.swapchainFormat;
        viewInfo.subresourceRange.aspectMask = VK_IMAGE_ASPECT_COLOR_BIT;
        viewInfo.subresourceRange.baseMipLevel = 0;
        viewInfo.subresourceRange.levelCount = 1;
        viewInfo.subresourceRange.baseArrayLayer = 0;
        viewInfo.subresourceRange.layerCount = 1;

        if (vkCreateImageView(vkCtx.device, &viewInfo, nullptr, &vkCtx.swapchainImageViews[i]) != VK_SUCCESS) {
            return false;
        }

        VkSemaphoreCreateInfo semInfo{};
        semInfo.sType = VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO;
        if (vkCreateSemaphore(vkCtx.device, &semInfo, nullptr, &vkCtx.renderCompleteSemaphores[i]) != VK_SUCCESS) {
            return false;
        }
    }

    // Create Depth Buffer for Pass 1 (3D Scene Pass)
    VkImageCreateInfo depthImgInfo{};
    depthImgInfo.sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO;
    depthImgInfo.imageType = VK_IMAGE_TYPE_2D;
    depthImgInfo.format = vkCtx.depthFormat;
    depthImgInfo.extent.width = extent.width;
    depthImgInfo.extent.height = extent.height;
    depthImgInfo.extent.depth = 1;
    depthImgInfo.mipLevels = 1;
    depthImgInfo.arrayLayers = 1;
    depthImgInfo.samples = VK_SAMPLE_COUNT_1_BIT;
    depthImgInfo.tiling = VK_IMAGE_TILING_OPTIMAL;
    depthImgInfo.usage = VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT;
    depthImgInfo.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
    depthImgInfo.initialLayout = VK_IMAGE_LAYOUT_UNDEFINED;

    if (vkCreateImage(vkCtx.device, &depthImgInfo, nullptr, &vkCtx.depthImage) == VK_SUCCESS) {
        VkMemoryRequirements memReqs{};
        vkGetImageMemoryRequirements(vkCtx.device, vkCtx.depthImage, &memReqs);
        VkMemoryAllocateInfo allocInfo{};
        allocInfo.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO;
        allocInfo.allocationSize = memReqs.size;
        allocInfo.memoryTypeIndex = Find_Memory_Type(memReqs.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
        if (allocInfo.memoryTypeIndex != UINT32_MAX &&
            vkAllocateMemory(vkCtx.device, &allocInfo, nullptr, &vkCtx.depthMemory) == VK_SUCCESS) {
            vkBindImageMemory(vkCtx.device, vkCtx.depthImage, vkCtx.depthMemory, 0);

            VkImageViewCreateInfo depthViewInfo{};
            depthViewInfo.sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO;
            depthViewInfo.image = vkCtx.depthImage;
            depthViewInfo.viewType = VK_IMAGE_VIEW_TYPE_2D;
            depthViewInfo.format = vkCtx.depthFormat;
            depthViewInfo.subresourceRange.aspectMask = VK_IMAGE_ASPECT_DEPTH_BIT;
            depthViewInfo.subresourceRange.baseMipLevel = 0;
            depthViewInfo.subresourceRange.levelCount = 1;
            depthViewInfo.subresourceRange.baseArrayLayer = 0;
            depthViewInfo.subresourceRange.layerCount = 1;
            vkCreateImageView(vkCtx.device, &depthViewInfo, nullptr, &vkCtx.depthImageView);
        }
    }

    return true;
}

static bool Create_Present_Pipeline()
{
    if (vkCtx.presentPipeline) {
        vkDestroyPipeline(vkCtx.device, vkCtx.presentPipeline, nullptr);
        vkCtx.presentPipeline = VK_NULL_HANDLE;
    }
    if (vkCtx.ultraMenuPipeline) {
        vkDestroyPipeline(vkCtx.device, vkCtx.ultraMenuPipeline, nullptr);
        vkCtx.ultraMenuPipeline = VK_NULL_HANDLE;
    }

    VkPipelineShaderStageCreateInfo stages[2]{};
    stages[0].sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
    stages[0].stage = VK_SHADER_STAGE_VERTEX_BIT;
    stages[0].module = vkCtx.vertShader;
    stages[0].pName = "main";

    stages[1].sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
    stages[1].stage = VK_SHADER_STAGE_FRAGMENT_BIT;
    stages[1].module = vkCtx.fragShader;
    stages[1].pName = "main";

    VkPipelineVertexInputStateCreateInfo vertInput{};
    vertInput.sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO;

    VkPipelineInputAssemblyStateCreateInfo inputAssembly{};
    inputAssembly.sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO;
    inputAssembly.topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST;

    VkPipelineViewportStateCreateInfo viewportState{};
    viewportState.sType = VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO;
    viewportState.viewportCount = 1;
    viewportState.scissorCount = 1;

    VkPipelineRasterizationStateCreateInfo raster{};
    raster.sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO;
    raster.polygonMode = VK_POLYGON_MODE_FILL;
    raster.cullMode = VK_CULL_MODE_NONE;
    raster.frontFace = VK_FRONT_FACE_COUNTER_CLOCKWISE;
    raster.lineWidth = 1.0f;

    VkPipelineMultisampleStateCreateInfo multisample{};
    multisample.sType = VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO;
    multisample.rasterizationSamples = VK_SAMPLE_COUNT_1_BIT;

    VkPipelineDepthStencilStateCreateInfo depthStencil{};
    depthStencil.sType = VK_STRUCTURE_TYPE_PIPELINE_DEPTH_STENCIL_STATE_CREATE_INFO;
    depthStencil.depthTestEnable = VK_FALSE;
    depthStencil.depthWriteEnable = VK_FALSE;

    VkPipelineColorBlendAttachmentState blendAttach{};
    blendAttach.blendEnable = VK_FALSE;
    blendAttach.colorWriteMask =
        VK_COLOR_COMPONENT_R_BIT | VK_COLOR_COMPONENT_G_BIT | VK_COLOR_COMPONENT_B_BIT | VK_COLOR_COMPONENT_A_BIT;

    VkPipelineColorBlendStateCreateInfo blendState{};
    blendState.sType = VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO;
    blendState.attachmentCount = 1;
    blendState.pAttachments = &blendAttach;

    VkDynamicState dynStates[2] = {VK_DYNAMIC_STATE_VIEWPORT, VK_DYNAMIC_STATE_SCISSOR};
    VkPipelineDynamicStateCreateInfo dynStateInfo{};
    dynStateInfo.sType = VK_STRUCTURE_TYPE_PIPELINE_DYNAMIC_STATE_CREATE_INFO;
    dynStateInfo.dynamicStateCount = 2;
    dynStateInfo.pDynamicStates = dynStates;

    VkPipelineRenderingCreateInfo renderingInfo{};
    renderingInfo.sType = VK_STRUCTURE_TYPE_PIPELINE_RENDERING_CREATE_INFO;
    renderingInfo.colorAttachmentCount = 1;
    renderingInfo.pColorAttachmentFormats = &vkCtx.swapchainFormat;
    renderingInfo.depthAttachmentFormat = vkCtx.depthFormat;

    VkGraphicsPipelineCreateInfo pipeInfo{};
    pipeInfo.sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO;
    pipeInfo.pNext = &renderingInfo;
    pipeInfo.stageCount = 2;
    pipeInfo.pStages = stages;
    pipeInfo.pVertexInputState = &vertInput;
    pipeInfo.pInputAssemblyState = &inputAssembly;
    pipeInfo.pViewportState = &viewportState;
    pipeInfo.pRasterizationState = &raster;
    pipeInfo.pMultisampleState = &multisample;
    pipeInfo.pDepthStencilState = &depthStencil;
    pipeInfo.pColorBlendState = &blendState;
    pipeInfo.pDynamicState = &dynStateInfo;
    pipeInfo.layout = vkCtx.pipelineLayout;
    pipeInfo.renderPass = VK_NULL_HANDLE;

    if (vkCreateGraphicsPipelines(vkCtx.device, VK_NULL_HANDLE, 1, &pipeInfo, nullptr, &vkCtx.presentPipeline) !=
        VK_SUCCESS) {
        return false;
    }

    if (vkCtx.ultraMenuFragShader) {
        stages[1].module = vkCtx.ultraMenuFragShader;
        vkCreateGraphicsPipelines(vkCtx.device, VK_NULL_HANDLE, 1, &pipeInfo, nullptr, &vkCtx.ultraMenuPipeline);
    }

    if (vkCtx.tactical3DFragShader) {
        stages[1].module = vkCtx.tactical3DFragShader;
        vkCreateGraphicsPipelines(vkCtx.device, VK_NULL_HANDLE, 1, &pipeInfo, nullptr, &vkCtx.tactical3DPipeline);
    }

    return true;
}

static bool Initialize_Vulkan_Backend(int gameW, int gameH)
{
    uint32_t extCount = 0;
    if (!SDL_Vulkan_GetInstanceExtensions(window, &extCount, nullptr) || extCount == 0) {
        return false;
    }
    std::vector<const char*> extensions(extCount);
    SDL_Vulkan_GetInstanceExtensions(window, &extCount, extensions.data());

    VkApplicationInfo appInfo{};
    appInfo.sType = VK_STRUCTURE_TYPE_APPLICATION_INFO;
    appInfo.pApplicationName = "Vanilla Conquer";
    appInfo.applicationVersion = VK_MAKE_VERSION(1, 0, 0);
    appInfo.pEngineName = "Vanilla Conquer Vulkan";
    appInfo.engineVersion = VK_MAKE_VERSION(1, 0, 0);
    appInfo.apiVersion = VK_API_VERSION_1_3;

    VkInstanceCreateInfo instInfo{};
    instInfo.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO;
    instInfo.pApplicationInfo = &appInfo;
    instInfo.enabledExtensionCount = static_cast<uint32_t>(extensions.size());
    instInfo.ppEnabledExtensionNames = extensions.data();

    if (vkCreateInstance(&instInfo, nullptr, &vkCtx.instance) != VK_SUCCESS) {
        return false;
    }

    if (!SDL_Vulkan_CreateSurface(window, vkCtx.instance, &vkCtx.surface)) {
        return false;
    }

    uint32_t gpuCount = 0;
    vkEnumeratePhysicalDevices(vkCtx.instance, &gpuCount, nullptr);
    if (gpuCount == 0) return false;
    std::vector<VkPhysicalDevice> gpus(gpuCount);
    vkEnumeratePhysicalDevices(vkCtx.instance, &gpuCount, gpus.data());

    // Prefer discrete GPU supporting Vulkan 1.3 and graphics+present queue
    for (VkPhysicalDevice gpu : gpus) {
        uint32_t qCount = 0;
        vkGetPhysicalDeviceQueueFamilyProperties(gpu, &qCount, nullptr);
        std::vector<VkQueueFamilyProperties> qProps(qCount);
        vkGetPhysicalDeviceQueueFamilyProperties(gpu, &qCount, qProps.data());

        for (uint32_t i = 0; i < qCount; ++i) {
            VkBool32 presentSupport = VK_FALSE;
            vkGetPhysicalDeviceSurfaceSupportKHR(gpu, i, vkCtx.surface, &presentSupport);
            if ((qProps[i].queueFlags & VK_QUEUE_GRAPHICS_BIT) && presentSupport) {
                vkCtx.physicalDevice = gpu;
                vkCtx.graphicsQueueFamily = i;
                break;
            }
        }
        if (vkCtx.physicalDevice != VK_NULL_HANDLE) {
            VkPhysicalDeviceProperties props{};
            vkGetPhysicalDeviceProperties(gpu, &props);
            if (props.deviceType == VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU) {
                break;
            }
        }
    }

    if (vkCtx.physicalDevice == VK_NULL_HANDLE) {
        return false;
    }

    float queuePriority = 1.0f;
    VkDeviceQueueCreateInfo qCreateInfo{};
    qCreateInfo.sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO;
    qCreateInfo.queueFamilyIndex = vkCtx.graphicsQueueFamily;
    qCreateInfo.queueCount = 1;
    qCreateInfo.pQueuePriorities = &queuePriority;

    VkPhysicalDeviceVulkan12Features features12{};
    features12.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_FEATURES;
    features12.timelineSemaphore = VK_TRUE;

    VkPhysicalDeviceVulkan13Features features13{};
    features13.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_3_FEATURES;
    features13.pNext = &features12;
    features13.dynamicRendering = VK_TRUE;
    features13.synchronization2 = VK_TRUE;

    const char* devExtensions[] = {VK_KHR_SWAPCHAIN_EXTENSION_NAME};

    VkDeviceCreateInfo devInfo{};
    devInfo.sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO;
    devInfo.pNext = &features13;
    devInfo.queueCreateInfoCount = 1;
    devInfo.pQueueCreateInfos = &qCreateInfo;
    devInfo.enabledExtensionCount = 1;
    devInfo.ppEnabledExtensionNames = devExtensions;

    if (vkCreateDevice(vkCtx.physicalDevice, &devInfo, nullptr, &vkCtx.device) != VK_SUCCESS) {
        return false;
    }

    vkGetDeviceQueue(vkCtx.device, vkCtx.graphicsQueueFamily, 0, &vkCtx.graphicsQueue);

    int drawW = 0, drawH = 0;
    SDL_Vulkan_GetDrawableSize(window, &drawW, &drawH);
    if (drawW <= 0 || drawH <= 0) {
        drawW = gameW;
        drawH = gameH;
    }

    if (!Create_Swapchain(static_cast<uint32_t>(drawW), static_cast<uint32_t>(drawH))) {
        return false;
    }

    // Create nearest-neighbor sampler for 8-bit index texture
    VkSamplerCreateInfo sampInfo{};
    sampInfo.sType = VK_STRUCTURE_TYPE_SAMPLER_CREATE_INFO;
    sampInfo.magFilter = VK_FILTER_NEAREST;
    sampInfo.minFilter = VK_FILTER_NEAREST;
    sampInfo.mipmapMode = VK_SAMPLER_MIPMAP_MODE_NEAREST;
    sampInfo.addressModeU = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE;
    sampInfo.addressModeV = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE;
    sampInfo.addressModeW = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE;
    if (vkCreateSampler(vkCtx.device, &sampInfo, nullptr, &vkCtx.fbSampler) != VK_SUCCESS) {
        return false;
    }

    // Create linear sampler for Ultra Menu 4K RGBA texture & HUD font atlas
    VkSamplerCreateInfo menuSampInfo{};
    menuSampInfo.sType = VK_STRUCTURE_TYPE_SAMPLER_CREATE_INFO;
    menuSampInfo.magFilter = VK_FILTER_LINEAR;
    menuSampInfo.minFilter = VK_FILTER_LINEAR;
    menuSampInfo.mipmapMode = VK_SAMPLER_MIPMAP_MODE_LINEAR;
    menuSampInfo.addressModeU = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE;
    menuSampInfo.addressModeV = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE;
    menuSampInfo.addressModeW = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE;
    if (vkCreateSampler(vkCtx.device, &menuSampInfo, nullptr, &vkCtx.menuSampler) != VK_SUCCESS) {
        return false;
    }

    // Descriptor Set Layout (binding 0: usampler2D, binding 1: PaletteUBO, binding 2: sampler2D, binding 3: UltraMenuUBO, binding 4: Tactical3DUBO)
    VkDescriptorSetLayoutBinding bindings[5]{};
    bindings[0].binding = 0;
    bindings[0].descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER;
    bindings[0].descriptorCount = 1;
    bindings[0].stageFlags = VK_SHADER_STAGE_FRAGMENT_BIT;

    bindings[1].binding = 1;
    bindings[1].descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER;
    bindings[1].descriptorCount = 1;
    bindings[1].stageFlags = VK_SHADER_STAGE_FRAGMENT_BIT;

    bindings[2].binding = 2;
    bindings[2].descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER;
    bindings[2].descriptorCount = 1;
    bindings[2].stageFlags = VK_SHADER_STAGE_FRAGMENT_BIT;

    bindings[3].binding = 3;
    bindings[3].descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER;
    bindings[3].descriptorCount = 1;
    bindings[3].stageFlags = VK_SHADER_STAGE_FRAGMENT_BIT;

    bindings[4].binding = 4;
    bindings[4].descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER;
    bindings[4].descriptorCount = 1;
    bindings[4].stageFlags = VK_SHADER_STAGE_FRAGMENT_BIT;

    VkDescriptorSetLayoutCreateInfo dslInfo{};
    dslInfo.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO;
    dslInfo.bindingCount = 5;
    dslInfo.pBindings = bindings;
    if (vkCreateDescriptorSetLayout(vkCtx.device, &dslInfo, nullptr, &vkCtx.descriptorSetLayout) != VK_SUCCESS) {
        return false;
    }

    VkDescriptorPoolSize poolSizes[2]{};
    poolSizes[0].type = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER;
    poolSizes[0].descriptorCount = kMaxFramesInFlight * 2;
    poolSizes[1].type = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER;
    poolSizes[1].descriptorCount = kMaxFramesInFlight * 3;

    VkDescriptorPoolCreateInfo poolInfo{};
    poolInfo.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO;
    poolInfo.maxSets = kMaxFramesInFlight;
    poolInfo.poolSizeCount = 2;
    poolInfo.pPoolSizes = poolSizes;
    if (vkCreateDescriptorPool(vkCtx.device, &poolInfo, nullptr, &vkCtx.descriptorPool) != VK_SUCCESS) {
        return false;
    }

    VkDescriptorSetLayout layouts[kMaxFramesInFlight] = {vkCtx.descriptorSetLayout, vkCtx.descriptorSetLayout};
    VkDescriptorSetAllocateInfo dsAlloc{};
    dsAlloc.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO;
    dsAlloc.descriptorPool = vkCtx.descriptorPool;
    dsAlloc.descriptorSetCount = kMaxFramesInFlight;
    dsAlloc.pSetLayouts = layouts;

    VkDescriptorSet sets[kMaxFramesInFlight]{};
    if (vkAllocateDescriptorSets(vkCtx.device, &dsAlloc, sets) != VK_SUCCESS) {
        return false;
    }

    // Pipeline Layout & Shader Modules
    VkPipelineLayoutCreateInfo plInfo{};
    plInfo.sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO;
    plInfo.setLayoutCount = 1;
    plInfo.pSetLayouts = &vkCtx.descriptorSetLayout;
    if (vkCreatePipelineLayout(vkCtx.device, &plInfo, nullptr, &vkCtx.pipelineLayout) != VK_SUCCESS) {
        return false;
    }

    VkShaderModuleCreateInfo vertModInfo{};
    vertModInfo.sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO;
    vertModInfo.codeSize = sizeof(kFullscreenVertSpv);
    vertModInfo.pCode = kFullscreenVertSpv;
    if (vkCreateShaderModule(vkCtx.device, &vertModInfo, nullptr, &vkCtx.vertShader) != VK_SUCCESS) {
        return false;
    }

    VkShaderModuleCreateInfo fragModInfo{};
    fragModInfo.sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO;
    fragModInfo.codeSize = sizeof(kPaletteFragSpv);
    fragModInfo.pCode = kPaletteFragSpv;
    if (vkCreateShaderModule(vkCtx.device, &fragModInfo, nullptr, &vkCtx.fragShader) != VK_SUCCESS) {
        return false;
    }

    VkShaderModuleCreateInfo menuFragModInfo{};
    menuFragModInfo.sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO;
    menuFragModInfo.codeSize = sizeof(kUltraMenuFragSpv);
    menuFragModInfo.pCode = kUltraMenuFragSpv;
    vkCreateShaderModule(vkCtx.device, &menuFragModInfo, nullptr, &vkCtx.ultraMenuFragShader);

    VkShaderModuleCreateInfo tacFragModInfo{};
    tacFragModInfo.sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO;
    tacFragModInfo.codeSize = sizeof(kTactical3DFragSpv);
    tacFragModInfo.pCode = kTactical3DFragSpv;
    vkCreateShaderModule(vkCtx.device, &tacFragModInfo, nullptr, &vkCtx.tactical3DFragShader);

    if (!Create_Present_Pipeline()) {
        return false;
    }

    // Timeline Semaphore & Per-Frame Resources
    VkSemaphoreTypeCreateInfo timelineTypeInfo{};
    timelineTypeInfo.sType = VK_STRUCTURE_TYPE_SEMAPHORE_TYPE_CREATE_INFO;
    timelineTypeInfo.semaphoreType = VK_SEMAPHORE_TYPE_TIMELINE;
    timelineTypeInfo.initialValue = kMaxFramesInFlight;

    VkSemaphoreCreateInfo timelineSemInfo{};
    timelineSemInfo.sType = VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO;
    timelineSemInfo.pNext = &timelineTypeInfo;
    if (vkCreateSemaphore(vkCtx.device, &timelineSemInfo, nullptr, &vkCtx.timelineSemaphore) != VK_SUCCESS) {
        return false;
    }

    for (uint32_t i = 0; i < kMaxFramesInFlight; ++i) {
        VulkanFrameResources& fr = vkCtx.frames[i];
        fr.descriptorSet = sets[i];

        VkCommandPoolCreateInfo cpInfo{};
        cpInfo.sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO;
        cpInfo.queueFamilyIndex = vkCtx.graphicsQueueFamily;
        if (vkCreateCommandPool(vkCtx.device, &cpInfo, nullptr, &fr.commandPool) != VK_SUCCESS) {
            return false;
        }

        VkCommandBufferAllocateInfo cbAlloc{};
        cbAlloc.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO;
        cbAlloc.commandPool = fr.commandPool;
        cbAlloc.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
        cbAlloc.commandBufferCount = 1;
        if (vkAllocateCommandBuffers(vkCtx.device, &cbAlloc, &fr.commandBuffer) != VK_SUCCESS) {
            return false;
        }

        VkSemaphoreCreateInfo binSemInfo{};
        binSemInfo.sType = VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO;
        if (vkCreateSemaphore(vkCtx.device, &binSemInfo, nullptr, &fr.imageAcquiredSemaphore) != VK_SUCCESS) {
            return false;
        }

        if (!Create_Buffer(sizeof(PaletteUBOData),
                           VK_BUFFER_USAGE_UNIFORM_BUFFER_BIT,
                           VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT,
                           fr.paletteBuffer,
                           fr.paletteMemory,
                           &fr.paletteMapped)) {
            return false;
        }

        if (!Create_Buffer(sizeof(UltraMenuUBOData),
                           VK_BUFFER_USAGE_UNIFORM_BUFFER_BIT,
                           VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT,
                           fr.menuUboBuffer,
                           fr.menuUboMemory,
                           &fr.menuUboMapped)) {
            return false;
        }

        if (!Create_Buffer(sizeof(Tactical3DUBOData),
                           VK_BUFFER_USAGE_UNIFORM_BUFFER_BIT,
                           VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT,
                           fr.tacticalUboBuffer,
                           fr.tacticalUboMemory,
                           &fr.tacticalUboMapped)) {
            return false;
        }
    }

    vkCtx.initialized = true;
    Ensure_Menu_Texture();
    Ensure_Framebuffer_Texture(static_cast<uint32_t>(gameW), static_cast<uint32_t>(gameH));
    return true;
}

static void Shutdown_Vulkan_Backend()
{
    if (vkCtx.device) {
        vkDeviceWaitIdle(vkCtx.device);

        Destroy_Menu_Texture();
        Destroy_Framebuffer_Texture();
        Destroy_Swapchain();

        if (vkCtx.timelineSemaphore) {
            vkDestroySemaphore(vkCtx.device, vkCtx.timelineSemaphore, nullptr);
            vkCtx.timelineSemaphore = VK_NULL_HANDLE;
        }

        for (uint32_t i = 0; i < kMaxFramesInFlight; ++i) {
            VulkanFrameResources& fr = vkCtx.frames[i];
            if (fr.stagingMapped) vkUnmapMemory(vkCtx.device, fr.stagingMemory);
            if (fr.stagingBuffer) vkDestroyBuffer(vkCtx.device, fr.stagingBuffer, nullptr);
            if (fr.stagingMemory) vkFreeMemory(vkCtx.device, fr.stagingMemory, nullptr);
            if (fr.paletteMapped) vkUnmapMemory(vkCtx.device, fr.paletteMemory);
            if (fr.paletteBuffer) vkDestroyBuffer(vkCtx.device, fr.paletteBuffer, nullptr);
            if (fr.paletteMemory) vkFreeMemory(vkCtx.device, fr.paletteMemory, nullptr);
            if (fr.menuUboMapped) vkUnmapMemory(vkCtx.device, fr.menuUboMemory);
            if (fr.menuUboBuffer) vkDestroyBuffer(vkCtx.device, fr.menuUboBuffer, nullptr);
            if (fr.menuUboMemory) vkFreeMemory(vkCtx.device, fr.menuUboMemory, nullptr);
            if (fr.tacticalUboMapped) vkUnmapMemory(vkCtx.device, fr.tacticalUboMemory);
            if (fr.tacticalUboBuffer) vkDestroyBuffer(vkCtx.device, fr.tacticalUboBuffer, nullptr);
            if (fr.tacticalUboMemory) vkFreeMemory(vkCtx.device, fr.tacticalUboMemory, nullptr);
            if (fr.imageAcquiredSemaphore) vkDestroySemaphore(vkCtx.device, fr.imageAcquiredSemaphore, nullptr);
            if (fr.commandPool) vkDestroyCommandPool(vkCtx.device, fr.commandPool, nullptr);
            fr = VulkanFrameResources{};
        }

        if (vkCtx.tactical3DPipeline) vkDestroyPipeline(vkCtx.device, vkCtx.tactical3DPipeline, nullptr);
        if (vkCtx.ultraMenuPipeline) vkDestroyPipeline(vkCtx.device, vkCtx.ultraMenuPipeline, nullptr);
        if (vkCtx.presentPipeline) vkDestroyPipeline(vkCtx.device, vkCtx.presentPipeline, nullptr);
        if (vkCtx.vertShader) vkDestroyShaderModule(vkCtx.device, vkCtx.vertShader, nullptr);
        if (vkCtx.fragShader) vkDestroyShaderModule(vkCtx.device, vkCtx.fragShader, nullptr);
        if (vkCtx.ultraMenuFragShader) vkDestroyShaderModule(vkCtx.device, vkCtx.ultraMenuFragShader, nullptr);
        if (vkCtx.tactical3DFragShader) vkDestroyShaderModule(vkCtx.device, vkCtx.tactical3DFragShader, nullptr);
        if (vkCtx.pipelineLayout) vkDestroyPipelineLayout(vkCtx.device, vkCtx.pipelineLayout, nullptr);
        if (vkCtx.descriptorPool) vkDestroyDescriptorPool(vkCtx.device, vkCtx.descriptorPool, nullptr);
        if (vkCtx.descriptorSetLayout) vkDestroyDescriptorSetLayout(vkCtx.device, vkCtx.descriptorSetLayout, nullptr);
        if (vkCtx.menuSampler) vkDestroySampler(vkCtx.device, vkCtx.menuSampler, nullptr);
        if (vkCtx.fbSampler) vkDestroySampler(vkCtx.device, vkCtx.fbSampler, nullptr);

        vkDestroyDevice(vkCtx.device, nullptr);
        vkCtx.device = VK_NULL_HANDLE;
    }

    if (vkCtx.surface && vkCtx.instance) {
        vkDestroySurfaceKHR(vkCtx.instance, vkCtx.surface, nullptr);
        vkCtx.surface = VK_NULL_HANDLE;
    }

    if (vkCtx.instance) {
        vkDestroyInstance(vkCtx.instance, nullptr);
        vkCtx.instance = VK_NULL_HANDLE;
    }

    vkCtx.initialized = false;
}

/*=========================================================================*/
/* 3-Pass Composable Presentation Pipeline Architecture                    */
/*=========================================================================*/
// Pass 1: Optional 3D Scene Pass (clears/prepares depth + scene target for 3D conversion)
static void Execute_Pass1_Scene3D(VkCommandBuffer cmd, uint32_t imageIndex)
{
    if (!vkCtx.depthImageView) return;

    VkRenderingAttachmentInfo colorAttach{};
    colorAttach.sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO;
    colorAttach.imageView = vkCtx.swapchainImageViews[imageIndex];
    colorAttach.imageLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL;
    colorAttach.loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR;
    colorAttach.storeOp = VK_ATTACHMENT_STORE_OP_STORE;
    colorAttach.clearValue.color = {{0.0f, 0.0f, 0.0f, 1.0f}};

    VkRenderingAttachmentInfo depthAttach{};
    depthAttach.sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO;
    depthAttach.imageView = vkCtx.depthImageView;
    depthAttach.imageLayout = VK_IMAGE_LAYOUT_DEPTH_ATTACHMENT_OPTIMAL;
    depthAttach.loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR;
    depthAttach.storeOp = VK_ATTACHMENT_STORE_OP_DONT_CARE;
    depthAttach.clearValue.depthStencil = {1.0f, 0};

    VkRenderingInfo renderInfo{};
    renderInfo.sType = VK_STRUCTURE_TYPE_RENDERING_INFO;
    renderInfo.renderArea.offset = {0, 0};
    renderInfo.renderArea.extent = {vkCtx.swapchainWidth, vkCtx.swapchainHeight};
    renderInfo.layerCount = 1;
    renderInfo.colorAttachmentCount = 1;
    renderInfo.pColorAttachments = &colorAttach;
    renderInfo.pDepthAttachment = &depthAttach;

    vkCmdBeginRendering(cmd, &renderInfo);
    // Future 3D terrain, voxel, and glTF unit draw calls execute here in Pass 1.
    vkCmdEndRendering(cmd);
}

static void Compute_Letterbox_Rect(int out_w, int out_h, int game_w, int game_h, SDL_Rect& dst)
{
    int gw = game_w > 0 ? game_w : 640;
    int gh = game_h > 0 ? game_h : 400;
    if (out_w <= 0 || out_h <= 0) {
        dst.x = 0;
        dst.y = 0;
        dst.w = gw;
        dst.h = gh;
        return;
    }

    if (Settings.Video.Boxing) {
        float ar = static_cast<float>(gw) / static_cast<float>(gh);
        if (ultraMenuState.active && vkCtx.menuTexLoaded) {
            ar = 2752.0f / 1536.0f;
        } else {
            size_t colonPos = Settings.Video.BoxingAspectRatio.find(":");
            if (colonPos != std::string::npos) {
                size_t arLen = Settings.Video.BoxingAspectRatio.length();
                std::string arW = Settings.Video.BoxingAspectRatio.substr(0, colonPos);
                std::string arH = Settings.Video.BoxingAspectRatio.substr(colonPos + 1, arLen - colonPos);
                float w_val = std::stof(arW);
                float h_val = std::stof(arH);
                if (w_val > 0.0f && h_val > 0.0f) {
                    ar = w_val / h_val;
                }
            }
        }

        dst.w = out_w;
        dst.h = static_cast<int>(dst.w / ar);
        if (dst.h > out_h) {
            dst.h = out_h;
            dst.w = static_cast<int>(dst.h * ar);
        }
        dst.x = (out_w - dst.w) / 2;
        dst.y = (out_h - dst.h) / 2;
    } else {
        dst.x = 0;
        dst.y = 0;
        dst.w = out_w;
        dst.h = out_h;
    }
}

// Pass 2: Software Framebuffer Presentation Pass (letterboxed 16:10 / 4:3 quad with GPU palette lookup)
static void Execute_Pass2_SoftwareFramebuffer(VkCommandBuffer cmd, uint32_t imageIndex, uint32_t frameIdx)
{
    VkRenderingAttachmentInfo colorAttach{};
    colorAttach.sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO;
    colorAttach.imageView = vkCtx.swapchainImageViews[imageIndex];
    colorAttach.imageLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL;
    colorAttach.loadOp = vkCtx.depthImageView ? VK_ATTACHMENT_LOAD_OP_LOAD : VK_ATTACHMENT_LOAD_OP_CLEAR;
    colorAttach.storeOp = VK_ATTACHMENT_STORE_OP_STORE;
    colorAttach.clearValue.color = {{0.0f, 0.0f, 0.0f, 1.0f}};

    VkRenderingInfo renderInfo{};
    renderInfo.sType = VK_STRUCTURE_TYPE_RENDERING_INFO;
    renderInfo.renderArea.offset = {0, 0};
    renderInfo.renderArea.extent = {vkCtx.swapchainWidth, vkCtx.swapchainHeight};
    renderInfo.layerCount = 1;
    renderInfo.colorAttachmentCount = 1;
    renderInfo.pColorAttachments = &colorAttach;

    vkCmdBeginRendering(cmd, &renderInfo);

    SDL_Rect vk_dst{};
    Compute_Letterbox_Rect(static_cast<int>(vkCtx.swapchainWidth),
                           static_cast<int>(vkCtx.swapchainHeight),
                           hwcursor.GameW,
                           hwcursor.GameH,
                           vk_dst);

    int vx = std::max(0, vk_dst.x);
    int vy = std::max(0, vk_dst.y);
    int vw = vk_dst.w > 0 ? vk_dst.w : static_cast<int>(vkCtx.swapchainWidth);
    int vh = vk_dst.h > 0 ? vk_dst.h : static_cast<int>(vkCtx.swapchainHeight);

    VkViewport viewport{};
    viewport.x = static_cast<float>(vx);
    viewport.y = static_cast<float>(vy);
    viewport.width = static_cast<float>(vw);
    viewport.height = static_cast<float>(vh);
    viewport.minDepth = 0.0f;
    viewport.maxDepth = 1.0f;
    vkCmdSetViewport(cmd, 0, 1, &viewport);

    VkRect2D scissor{};
    scissor.offset = {vx, vy};
    scissor.extent = {static_cast<uint32_t>(vw), static_cast<uint32_t>(vh)};
    vkCmdSetScissor(cmd, 0, 1, &scissor);

    VkPipeline activePipe = vkCtx.presentPipeline;
    if (ultraMenuState.active && vkCtx.menuTexLoaded && vkCtx.ultraMenuPipeline != VK_NULL_HANDLE) {
        activePipe = vkCtx.ultraMenuPipeline;
    } else if (tactical3DState.active && vkCtx.tactical3DPipeline != VK_NULL_HANDLE) {
        activePipe = vkCtx.tactical3DPipeline;
    }
    vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, activePipe);
    vkCmdBindDescriptorSets(
        cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, vkCtx.pipelineLayout, 0, 1, &vkCtx.frames[frameIdx].descriptorSet, 0, nullptr);
    vkCmdDraw(cmd, 3, 1, 0, 0);

    vkCmdEndRendering(cmd);
}

// Pass 3: Native High-DPI UI Overlay Pass (composable hook for native Vulkan UI)
static void Execute_Pass3_NativeUI(VkCommandBuffer cmd, uint32_t imageIndex)
{
    VkRenderingAttachmentInfo colorAttach{};
    colorAttach.sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO;
    colorAttach.imageView = vkCtx.swapchainImageViews[imageIndex];
    colorAttach.imageLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL;
    colorAttach.loadOp = VK_ATTACHMENT_LOAD_OP_LOAD;
    colorAttach.storeOp = VK_ATTACHMENT_STORE_OP_STORE;

    VkRenderingInfo renderInfo{};
    renderInfo.sType = VK_STRUCTURE_TYPE_RENDERING_INFO;
    renderInfo.renderArea.offset = {0, 0};
    renderInfo.renderArea.extent = {vkCtx.swapchainWidth, vkCtx.swapchainHeight};
    renderInfo.layerCount = 1;
    renderInfo.colorAttachmentCount = 1;
    renderInfo.pColorAttachments = &colorAttach;

    vkCmdBeginRendering(cmd, &renderInfo);
    // Future native High-DPI Vulkan sidebar, radar, and UI widgets render here in Pass 3.
    vkCmdEndRendering(cmd);
}

/*=========================================================================*/
/* Window Letterbox & Hardware Cursor Management                           */
/*=========================================================================*/
static void Update_HWCursor_Settings()
{
    int win_w = 0, win_h = 0;
    if (window) {
        SDL_Vulkan_GetDrawableSize(window, &win_w, &win_h);
        if (win_w <= 0 || win_h <= 0) {
            SDL_GetWindowSize(window, &win_w, &win_h);
        }
    }
    if (win_w <= 0 || win_h <= 0) {
        win_w = hwcursor.GameW > 0 ? hwcursor.GameW : 640;
        win_h = hwcursor.GameH > 0 ? hwcursor.GameH : 400;
    }

    last_out_w = win_w;
    last_out_h = win_h;
    hwcursor.ScaleX = win_w / static_cast<float>(hwcursor.GameW > 0 ? hwcursor.GameW : 640);
    hwcursor.ScaleY = win_h / static_cast<float>(hwcursor.GameH > 0 ? hwcursor.GameH : 400);

    float ar = static_cast<float>(hwcursor.GameW) / static_cast<float>(hwcursor.GameH > 0 ? hwcursor.GameH : 400);
    if (Settings.Video.Boxing) {
        size_t colonPos = Settings.Video.BoxingAspectRatio.find(":");
        std::string arW = "4";
        std::string arH = "3";
        if (colonPos != std::string::npos) {
            size_t arLen = Settings.Video.BoxingAspectRatio.length();
            arW = Settings.Video.BoxingAspectRatio.substr(0, colonPos);
            arH = Settings.Video.BoxingAspectRatio.substr(colonPos + 1, arLen - colonPos);
        }
        ar = std::stof(arW) / std::stof(arH);

        render_dst.w = win_w;
        render_dst.h = static_cast<int>(render_dst.w / ar);
        if (render_dst.h > win_h) {
            render_dst.h = win_h;
            render_dst.w = static_cast<int>(render_dst.h * ar);
        }
        render_dst.x = (win_w - render_dst.w) / 2;
        render_dst.y = (win_h - render_dst.h) / 2;
    } else {
        render_dst.w = win_w;
        render_dst.h = win_h;
        render_dst.x = 0;
        render_dst.y = 0;
    }

    Set_Video_Cursor_Clip(hwcursor.Clip);
    Update_HWCursor();
}

static void Update_HWCursor()
{
    if (!hwcursor.Raw || hwcursor.W <= 0 || hwcursor.H <= 0 || !palette) {
        return;
    }

    float scale_x = 1.0f;
    float scale_y = 1.0f;
    int scaled_w = hwcursor.W;
    int scaled_h = hwcursor.H;

    if (Settings.Video.HardwareCursor) {
        scale_x = hwcursor.ScaleX > 0.0f ? hwcursor.ScaleX : 1.0f;
        scale_y = hwcursor.ScaleY > 0.0f ? hwcursor.ScaleY : 1.0f;
        scaled_w = std::max(1, static_cast<int>(scaled_w * scale_x));
        scaled_h = std::max(1, static_cast<int>(scaled_h * scale_y));
    }

    if (hwcursor.Surface == nullptr || hwcursor.Surface->w != scaled_w || hwcursor.Surface->h != scaled_h) {
        if (hwcursor.Surface) {
            SDL_FreeSurface(hwcursor.Surface);
            hwcursor.Surface = nullptr;
        }

        if (Settings.Video.HardwareCursor) {
            hwcursor.Surface = SDL_CreateRGBSurfaceWithFormat(0, scaled_w, scaled_h, 8, SDL_PIXELFORMAT_INDEX8);
        } else {
            hwcursor.Surface =
                SDL_CreateRGBSurfaceFrom(hwcursor.Raw, hwcursor.W, hwcursor.H, 8, hwcursor.W, 0, 0, 0, 0);
        }

        if (hwcursor.Surface) {
            SDL_SetSurfacePalette(hwcursor.Surface, palette);
            SDL_SetColorKey(hwcursor.Surface, SDL_TRUE, 0);
        }
    }

    if (Settings.Video.HardwareCursor && hwcursor.Surface) {
        uint8_t* src = static_cast<uint8_t*>(hwcursor.Raw);
        uint8_t* dst = static_cast<uint8_t*>(hwcursor.Surface->pixels);
        int src_pitch = hwcursor.W;
        int dst_pitch = hwcursor.Surface->pitch;

        for (int y = 0; y < scaled_h; y++) {
            for (int x = 0; x < scaled_w; x++) {
                int sx = std::max(0, std::min(static_cast<int>(x / scale_x), hwcursor.W - 1));
                int sy = std::max(0, std::min(static_cast<int>(y / scale_y), hwcursor.H - 1));
                dst[dst_pitch * y + x] = src[src_pitch * sy + sx];
            }
        }

        if (hwcursor.Pending) {
            SDL_FreeCursor(hwcursor.Pending);
        }

        hwcursor.Pending = SDL_CreateColorCursor(hwcursor.Surface,
                                                 static_cast<int>(hwcursor.HotX * scale_x),
                                                 static_cast<int>(hwcursor.HotY * scale_y));
    }
}

/*=========================================================================*/
/* SurfaceMonitorClass & VideoSurfaceVulkan                                */
/*=========================================================================*/
class SurfaceMonitorClassDummy : public SurfaceMonitorClass
{
public:
    SurfaceMonitorClassDummy() {}
    virtual ~SurfaceMonitorClassDummy() override {}
    virtual void Restore_Surfaces() override {}
    virtual void Set_Surface_Focus(bool in_focus) override { (void)in_focus; }
    virtual void Release() override {}
};

static SurfaceMonitorClassDummy AllSurfacesDummy;
SurfaceMonitorClass& AllSurfaces = AllSurfacesDummy;

SurfaceMonitorClass::SurfaceMonitorClass()
{
    SurfacesRestored = false;
}

class VideoSurfaceVulkan;
static VideoSurfaceVulkan* frontSurface = nullptr;

class VideoSurfaceVulkan : public VideoSurface
{
public:
    VideoSurfaceVulkan(int w, int h, GBC_Enum flags)
        : width(w)
        , height(h)
        , flags(flags)
        , buffer(nullptr)
    {
        if (w > 0 && h > 0) {
            buffer = new uint8_t[w * h]();
        }
        if (flags & GBC_VISIBLE) {
            frontSurface = this;
            Ensure_Framebuffer_Texture(static_cast<uint32_t>(w), static_cast<uint32_t>(h));
        }
    }

    virtual ~VideoSurfaceVulkan() override
    {
        if (frontSurface == this) {
            frontSurface = nullptr;
        }
        delete[] buffer;
    }

    virtual void* GetData() const override
    {
        return buffer;
    }

    virtual int GetPitch() const override
    {
        return width;
    }

    virtual bool IsAllocated() const override
    {
        return false;
    }

    virtual void AddAttachedSurface(VideoSurface* surface) override
    {
        (void)surface;
    }

    virtual bool IsReadyToBlit() override
    {
        return true;
    }

    virtual bool LockWait() override
    {
        return buffer != nullptr;
    }

    virtual bool Unlock() override
    {
        return true;
    }

    virtual void Blt(const Rect& destRect, VideoSurface* src, const Rect& srcRect, bool mask) override
    {
        if (!src || !buffer) return;
        const uint8_t* srcData = static_cast<const uint8_t*>(src->GetData());
        if (!srcData) return;
        int srcPitch = src->GetPitch();

        int copyW = std::min(destRect.Width, srcRect.Width);
        int copyH = std::min(destRect.Height, srcRect.Height);

        for (int y = 0; y < copyH; ++y) {
            int dy = destRect.Y + y;
            int sy = srcRect.Y + y;
            if (dy < 0 || dy >= height || sy < 0) continue;

            for (int x = 0; x < copyW; ++x) {
                int dx = destRect.X + x;
                int sx = srcRect.X + x;
                if (dx < 0 || dx >= width || sx < 0 || sx >= srcPitch) continue;

                uint8_t px = srcData[sy * srcPitch + sx];
                if (!mask || px != 0) {
                    buffer[dy * width + dx] = px;
                }
            }
        }
    }

    virtual void FillRect(const Rect& rect, unsigned char color) override
    {
        if (!buffer) return;
        int x0 = std::max(0, rect.X);
        int y0 = std::max(0, rect.Y);
        int x1 = std::min(width, rect.X + rect.Width + 1);
        int y1 = std::min(height, rect.Y + rect.Height + 1);
        if (x1 <= x0 || y1 <= y0) return;

        for (int y = y0; y < y1; ++y) {
            std::memset(buffer + y * width + x0, color, static_cast<size_t>(x1 - x0));
        }
    }

    void RenderSurface()
    {
        if (!vkCtx.initialized || !buffer || width <= 0 || height <= 0) {
            return;
        }

        int cur_w = 0, cur_h = 0;
        SDL_Vulkan_GetDrawableSize(window, &cur_w, &cur_h);
        if (cur_w <= 0 || cur_h <= 0) {
            // Window is minimized (0x0); skip rendering safely
            return;
        }

        if (cur_w != last_out_w || cur_h != last_out_h ||
            cur_w != static_cast<int>(vkCtx.swapchainWidth) ||
            cur_h != static_cast<int>(vkCtx.swapchainHeight)) {
            Update_HWCursor_Settings();
            vkCtx.requireSwapchainRecreate = true;
        }

        if (vkCtx.requireSwapchainRecreate) {
            vkDeviceWaitIdle(vkCtx.device);
            Destroy_Swapchain();
            if (!Create_Swapchain(static_cast<uint32_t>(cur_w), static_cast<uint32_t>(cur_h))) {
                return;
            }
            Update_HWCursor_Settings();
            vkCtx.requireSwapchainRecreate = false;
        }

        Ensure_Framebuffer_Texture(static_cast<uint32_t>(width), static_cast<uint32_t>(height));

        // Update SDL Hardware Cursor state once per frame
        if (Settings.Video.HardwareCursor) {
            if (hwcursor.Pending) {
                SDL_SetCursor(hwcursor.Pending);
                if (hwcursor.Current) {
                    SDL_FreeCursor(hwcursor.Current);
                }
                hwcursor.Current = hwcursor.Pending;
                hwcursor.Pending = nullptr;
            }
            SDL_ShowCursor(!Get_Mouse_State());
        }

        const uint32_t frameIdx = static_cast<uint32_t>(vkCtx.frameIndex++ % kMaxFramesInFlight);
        const uint64_t signalValue = vkCtx.nextSignalValue++;
        const uint64_t waitValue = signalValue - kMaxFramesInFlight;

        VkSemaphoreWaitInfo waitInfo{};
        waitInfo.sType = VK_STRUCTURE_TYPE_SEMAPHORE_WAIT_INFO;
        waitInfo.semaphoreCount = 1;
        waitInfo.pSemaphores = &vkCtx.timelineSemaphore;
        waitInfo.pValues = &waitValue;
        vkWaitSemaphores(vkCtx.device, &waitInfo, UINT64_MAX);

        VulkanFrameResources& fr = vkCtx.frames[frameIdx];

        // Copy 8-bit software framebuffer + optional software cursor into staging buffer
        const size_t fbBytes = static_cast<size_t>(width) * static_cast<size_t>(height);
        if (fr.stagingMapped && fr.stagingCapacity >= fbBytes) {
            uint8_t* stagePtr = static_cast<uint8_t*>(fr.stagingMapped);
            std::memcpy(stagePtr, buffer, fbBytes);

            int mx = 0, my = 0;
            Get_Video_Mouse(mx, my);
            int gw = width > 0 ? width : 640;
            int gh = height > 0 ? height : 400;

            bool showCursor = !Settings.Video.HardwareCursor && (!Get_Mouse_State() || tactical3DState.active);
            if (showCursor && hwcursor.Raw && hwcursor.W > 0 && hwcursor.H > 0) {
                int startX = mx - hwcursor.HotX;
                int startY = my - hwcursor.HotY;
                const uint8_t* curData = static_cast<const uint8_t*>(hwcursor.Raw);

                if (tactical3DState.active) {
                    int tacX0 = static_cast<int>(tactical3DState.ubo.view_params0[1] * gw);
                    int tacY0 = static_cast<int>(tactical3DState.ubo.view_params0[2] * gh);
                    int tacX1 = static_cast<int>(tactical3DState.ubo.view_params0[3] * gw);
                    int tacY1 = static_cast<int>(tactical3DState.ubo.view_params1[0] * gh);

                    int dlgX0 = static_cast<int>(tactical3DState.dialogRect[0] * gw);
                    int dlgY0 = static_cast<int>(tactical3DState.dialogRect[1] * gh);
                    int dlgX1 = static_cast<int>(tactical3DState.dialogRect[2] * gw);
                    int dlgY1 = static_cast<int>(tactical3DState.dialogRect[3] * gh);
                    bool hasDlg = (dlgX1 > dlgX0 && dlgY1 > dlgY0);

                    int tipX0 = static_cast<int>(tactical3DState.ubo.overlay_rects[2][0] * gw);
                    int tipY0 = static_cast<int>(tactical3DState.ubo.overlay_rects[2][1] * gh);
                    int tipX1 = static_cast<int>(tactical3DState.ubo.overlay_rects[2][2] * gw);
                    int tipY1 = static_cast<int>(tactical3DState.ubo.overlay_rects[2][3] * gh);
                    bool hasTip = (tipX1 > tipX0 && tipY1 > tipY0);

                    float msgV1 = std::fmod(tactical3DState.ubo.view_params3[2], 1.0f);
                    int msgY1 = (msgV1 > 0.001f) ? static_cast<int>(msgV1 * gh) : -1;

                    for (int cy = -1; cy <= hwcursor.H; ++cy) {
                        int dy = startY + cy;
                        if (dy < 0 || dy >= height) continue;
                        for (int cx = -1; cx <= hwcursor.W; ++cx) {
                            int dx = startX + cx;
                            if (dx < 0 || dx >= width) continue;

                            bool inTac = (dx >= tacX0 && dx < tacX1 && dy >= 0 && dy < tacY1);
                            bool inDlg = hasDlg && (dx >= dlgX0 && dx <= dlgX1 && dy >= dlgY0 && dy <= dlgY1);
                            bool inTip = hasTip && (dx >= tipX0 && dx <= tipX1 && dy >= tipY0 && dy <= tipY1);
                            bool inMsg = (msgY1 > 0 && dy <= msgY1);
                            bool in3DScene = inTac && !inDlg && !inTip && !inMsg;

                            uint8_t cpx = 0;
                            if (cx >= 0 && cx < hwcursor.W && cy >= 0 && cy < hwcursor.H) {
                                cpx = curData[cy * hwcursor.W + cx];
                            }

                            if (in3DScene) {
                                // Clear legacy 2D terrain bytes inside cursor box so 3D shader composites clean cursor
                                stagePtr[dy * width + dx] = cpx;
                            }
                        }
                    }

                    if (startX <= 1 && startY <= 1) {
                        tactical3DState.ubo.overlay_rects[3][0] = -1.0f;
                        tactical3DState.ubo.overlay_rects[3][1] = -1.0f;
                        tactical3DState.ubo.overlay_rects[3][2] = -1.0f;
                        tactical3DState.ubo.overlay_rects[3][3] = -1.0f;
                    } else {
                        tactical3DState.ubo.overlay_rects[3][0] = static_cast<float>(startX) / static_cast<float>(gw);
                        tactical3DState.ubo.overlay_rects[3][1] = static_cast<float>(startY) / static_cast<float>(gh);
                        tactical3DState.ubo.overlay_rects[3][2] = static_cast<float>(startX + hwcursor.W) / static_cast<float>(gw);
                        tactical3DState.ubo.overlay_rects[3][3] = static_cast<float>(startY + hwcursor.H) / static_cast<float>(gh);
                    }
                } else {
                    for (int cy = 0; cy < hwcursor.H; ++cy) {
                        int dy = startY + cy;
                        if (dy < 0 || dy >= height) continue;
                        for (int cx = 0; cx < hwcursor.W; ++cx) {
                            int dx = startX + cx;
                            if (dx < 0 || dx >= width) continue;
                            uint8_t cpx = curData[cy * hwcursor.W + cx];
                            if (cpx != 0) {
                                stagePtr[dy * width + dx] = cpx;
                            }
                        }
                    }
                }
            } else if (tactical3DState.active) {
                tactical3DState.ubo.overlay_rects[3][0] = static_cast<float>(mx) / static_cast<float>(gw);
                tactical3DState.ubo.overlay_rects[3][1] = static_cast<float>(my) / static_cast<float>(gh);
                tactical3DState.ubo.overlay_rects[3][2] = -1.0f;
                tactical3DState.ubo.overlay_rects[3][3] = -1.0f;
            }
        }

        // Copy current 256-entry palette into per-frame UBO
        if (fr.paletteMapped) {
            std::memcpy(fr.paletteMapped, &vkCtx.currentPalette, sizeof(PaletteUBOData));
        }

        // Update Ultra Menu live UBO (time, mouse UV, button states, and labels)
        if (fr.menuUboMapped) {
            auto now = std::chrono::steady_clock::now();
            float elapsed = std::chrono::duration<float>(now - ultraMenuState.startTime).count();
            int mx = 0, my = 0;
            Get_Video_Mouse(mx, my);
            int gw = hwcursor.GameW > 0 ? hwcursor.GameW : 640;
            int gh = hwcursor.GameH > 0 ? hwcursor.GameH : 400;
            Uint32 mButtons = SDL_GetMouseState(nullptr, nullptr);

            ultraMenuState.ubo.params0[0] = elapsed;
            ultraMenuState.ubo.params0[1] = static_cast<float>(mx) / static_cast<float>(gw);
            ultraMenuState.ubo.params0[2] = static_cast<float>(my) / static_cast<float>(gh);
            ultraMenuState.ubo.params0[3] =
                vkCtx.swapchainHeight > 0
                    ? static_cast<float>(vkCtx.swapchainWidth) / static_cast<float>(vkCtx.swapchainHeight)
                    : 1.7778f;
            ultraMenuState.ubo.params1[1] = (!Get_Mouse_State()) ? 1.0f : 0.0f;
            ultraMenuState.ubo.params1[2] = (mButtons & SDL_BUTTON(SDL_BUTTON_LEFT)) ? 1.0f : 0.0f;

            // Compute live palette brightness so Fade_Palette_To smoothly fades the 4K Ultra Console in/out
            float maxPalComp = 0.0f;
            for (int pi = 1; pi < 255; ++pi) {
                maxPalComp = std::max(maxPalComp, vkCtx.currentPalette.colors[pi][0]);
                maxPalComp = std::max(maxPalComp, vkCtx.currentPalette.colors[pi][1]);
                maxPalComp = std::max(maxPalComp, vkCtx.currentPalette.colors[pi][2]);
            }
            ultraMenuState.ubo.params1[3] = std::min(1.0f, std::max(0.0f, maxPalComp));

            std::memcpy(fr.menuUboMapped, &ultraMenuState.ubo, sizeof(UltraMenuUBOData));
        }

        // Update Tactical 3D live UBO (time, palette fade, and active dialog overlay rect)
        if (fr.tacticalUboMapped && tactical3DState.active) {
            auto now = std::chrono::steady_clock::now();
            float elapsed = std::chrono::duration<float>(now - tactical3DState.startTime).count();
            tactical3DState.ubo.view_params0[0] = elapsed;

            float maxPalComp = 0.0f;
            for (int pi = 1; pi < 255; ++pi) {
                maxPalComp = std::max(maxPalComp, vkCtx.currentPalette.colors[pi][0]);
                maxPalComp = std::max(maxPalComp, vkCtx.currentPalette.colors[pi][1]);
                maxPalComp = std::max(maxPalComp, vkCtx.currentPalette.colors[pi][2]);
            }
            tactical3DState.ubo.view_params3[3] = std::min(1.0f, std::max(0.0f, maxPalComp));
            for (int k = 0; k < 4; ++k) {
                tactical3DState.ubo.overlay_rects[1][k] = tactical3DState.dialogRect[k];
            }

            std::memcpy(fr.tacticalUboMapped, &tactical3DState.ubo, sizeof(Tactical3DUBOData));
        }

        uint32_t imageIndex = 0;
        VkResult acq = vkAcquireNextImageKHR(
            vkCtx.device, vkCtx.swapchain, UINT64_MAX, fr.imageAcquiredSemaphore, VK_NULL_HANDLE, &imageIndex);

        if (acq == VK_ERROR_OUT_OF_DATE_KHR) {
            vkCtx.requireSwapchainRecreate = true;
            vkCtx.frameIndex--;
            vkCtx.nextSignalValue--;
            return;
        } else if (acq == VK_SUBOPTIMAL_KHR) {
            vkCtx.requireSwapchainRecreate = true;
        } else if (acq != VK_SUCCESS) {
            vkCtx.frameIndex--;
            vkCtx.nextSignalValue--;
            return;
        }

        vkResetCommandPool(vkCtx.device, fr.commandPool, 0);

        VkCommandBufferBeginInfo beginInfo{};
        beginInfo.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO;
        beginInfo.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
        vkBeginCommandBuffer(fr.commandBuffer, &beginInfo);

        // 1. Transition fbImage to TRANSFER_DST_OPTIMAL and upload 8-bit framebuffer from staging ring
        VkImageMemoryBarrier2 fbToTransfer{};
        fbToTransfer.sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER_2;
        fbToTransfer.srcStageMask = VK_PIPELINE_STAGE_2_FRAGMENT_SHADER_BIT;
        fbToTransfer.srcAccessMask = vkCtx.fbLayoutInitialized ? VK_ACCESS_2_SHADER_SAMPLED_READ_BIT : 0;
        fbToTransfer.dstStageMask = VK_PIPELINE_STAGE_2_TRANSFER_BIT;
        fbToTransfer.dstAccessMask = VK_ACCESS_2_TRANSFER_WRITE_BIT;
        fbToTransfer.oldLayout =
            vkCtx.fbLayoutInitialized ? VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL : VK_IMAGE_LAYOUT_UNDEFINED;
        fbToTransfer.newLayout = VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL;
        fbToTransfer.image = vkCtx.fbImage;
        fbToTransfer.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};

        VkDependencyInfo depToTransfer{};
        depToTransfer.sType = VK_STRUCTURE_TYPE_DEPENDENCY_INFO;
        depToTransfer.imageMemoryBarrierCount = 1;
        depToTransfer.pImageMemoryBarriers = &fbToTransfer;
        vkCmdPipelineBarrier2(fr.commandBuffer, &depToTransfer);

        VkBufferImageCopy copyRegion{};
        copyRegion.bufferOffset = 0;
        copyRegion.bufferRowLength = 0;
        copyRegion.bufferImageHeight = 0;
        copyRegion.imageSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1};
        copyRegion.imageOffset = {0, 0, 0};
        copyRegion.imageExtent = {vkCtx.fbWidth, vkCtx.fbHeight, 1};
        vkCmdCopyBufferToImage(
            fr.commandBuffer, fr.stagingBuffer, vkCtx.fbImage, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1, &copyRegion);

        // 2. Transition fbImage to SHADER_READ_ONLY_OPTIMAL and swapchain image (+ depth) for rendering
        std::vector<VkImageMemoryBarrier2> renderBarriers;

        VkImageMemoryBarrier2 fbToShader{};
        fbToShader.sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER_2;
        fbToShader.srcStageMask = VK_PIPELINE_STAGE_2_TRANSFER_BIT;
        fbToShader.srcAccessMask = VK_ACCESS_2_TRANSFER_WRITE_BIT;
        fbToShader.dstStageMask = VK_PIPELINE_STAGE_2_FRAGMENT_SHADER_BIT;
        fbToShader.dstAccessMask = VK_ACCESS_2_SHADER_SAMPLED_READ_BIT;
        fbToShader.oldLayout = VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL;
        fbToShader.newLayout = VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL;
        fbToShader.image = vkCtx.fbImage;
        fbToShader.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};
        renderBarriers.push_back(fbToShader);
        vkCtx.fbLayoutInitialized = true;

        VkImageMemoryBarrier2 swapToColor{};
        swapToColor.sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER_2;
        swapToColor.srcStageMask = VK_PIPELINE_STAGE_2_COLOR_ATTACHMENT_OUTPUT_BIT;
        swapToColor.srcAccessMask = 0;
        swapToColor.dstStageMask = VK_PIPELINE_STAGE_2_COLOR_ATTACHMENT_OUTPUT_BIT;
        swapToColor.dstAccessMask = VK_ACCESS_2_COLOR_ATTACHMENT_WRITE_BIT;
        swapToColor.oldLayout = VK_IMAGE_LAYOUT_UNDEFINED;
        swapToColor.newLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL;
        swapToColor.image = vkCtx.swapchainImages[imageIndex];
        swapToColor.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};
        renderBarriers.push_back(swapToColor);

        if (vkCtx.depthImage) {
            VkImageMemoryBarrier2 depthBarrier{};
            depthBarrier.sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER_2;
            depthBarrier.srcStageMask = VK_PIPELINE_STAGE_2_EARLY_FRAGMENT_TESTS_BIT;
            depthBarrier.srcAccessMask = 0;
            depthBarrier.dstStageMask =
                VK_PIPELINE_STAGE_2_EARLY_FRAGMENT_TESTS_BIT | VK_PIPELINE_STAGE_2_LATE_FRAGMENT_TESTS_BIT;
            depthBarrier.dstAccessMask = VK_ACCESS_2_DEPTH_STENCIL_ATTACHMENT_WRITE_BIT;
            depthBarrier.oldLayout = VK_IMAGE_LAYOUT_UNDEFINED;
            depthBarrier.newLayout = VK_IMAGE_LAYOUT_DEPTH_ATTACHMENT_OPTIMAL;
            depthBarrier.image = vkCtx.depthImage;
            depthBarrier.subresourceRange = {VK_IMAGE_ASPECT_DEPTH_BIT, 0, 1, 0, 1};
            renderBarriers.push_back(depthBarrier);
        }

        VkDependencyInfo depRender{};
        depRender.sType = VK_STRUCTURE_TYPE_DEPENDENCY_INFO;
        depRender.imageMemoryBarrierCount = static_cast<uint32_t>(renderBarriers.size());
        depRender.pImageMemoryBarriers = renderBarriers.data();
        vkCmdPipelineBarrier2(fr.commandBuffer, &depRender);

        // 3. Execute Isolated 3-Pass Composable Presentation Pipeline
        Execute_Pass1_Scene3D(fr.commandBuffer, imageIndex);
        Execute_Pass2_SoftwareFramebuffer(fr.commandBuffer, imageIndex, frameIdx);
        Execute_Pass3_NativeUI(fr.commandBuffer, imageIndex);

        // 4. Transition swapchain image to PRESENT_SRC_KHR
        VkImageMemoryBarrier2 swapToPresent{};
        swapToPresent.sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER_2;
        swapToPresent.srcStageMask = VK_PIPELINE_STAGE_2_COLOR_ATTACHMENT_OUTPUT_BIT;
        swapToPresent.srcAccessMask = VK_ACCESS_2_COLOR_ATTACHMENT_WRITE_BIT;
        swapToPresent.dstStageMask = VK_PIPELINE_STAGE_2_NONE;
        swapToPresent.dstAccessMask = 0;
        swapToPresent.oldLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL;
        swapToPresent.newLayout = VK_IMAGE_LAYOUT_PRESENT_SRC_KHR;
        swapToPresent.image = vkCtx.swapchainImages[imageIndex];
        swapToPresent.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};

        VkDependencyInfo depPresent{};
        depPresent.sType = VK_STRUCTURE_TYPE_DEPENDENCY_INFO;
        depPresent.imageMemoryBarrierCount = 1;
        depPresent.pImageMemoryBarriers = &swapToPresent;
        vkCmdPipelineBarrier2(fr.commandBuffer, &depPresent);

        vkEndCommandBuffer(fr.commandBuffer);

        VkSemaphoreSubmitInfo waitSemInfo{};
        waitSemInfo.sType = VK_STRUCTURE_TYPE_SEMAPHORE_SUBMIT_INFO;
        waitSemInfo.semaphore = fr.imageAcquiredSemaphore;
        waitSemInfo.stageMask = VK_PIPELINE_STAGE_2_COLOR_ATTACHMENT_OUTPUT_BIT;

        VkSemaphoreSubmitInfo signalSemInfos[2]{};
        signalSemInfos[0].sType = VK_STRUCTURE_TYPE_SEMAPHORE_SUBMIT_INFO;
        signalSemInfos[0].semaphore = vkCtx.renderCompleteSemaphores[imageIndex];
        signalSemInfos[0].stageMask = VK_PIPELINE_STAGE_2_ALL_GRAPHICS_BIT;

        signalSemInfos[1].sType = VK_STRUCTURE_TYPE_SEMAPHORE_SUBMIT_INFO;
        signalSemInfos[1].semaphore = vkCtx.timelineSemaphore;
        signalSemInfos[1].value = signalValue;
        signalSemInfos[1].stageMask = VK_PIPELINE_STAGE_2_ALL_COMMANDS_BIT;

        VkCommandBufferSubmitInfo cmdSubmitInfo{};
        cmdSubmitInfo.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_SUBMIT_INFO;
        cmdSubmitInfo.commandBuffer = fr.commandBuffer;

        VkSubmitInfo2 submitInfo{};
        submitInfo.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO_2;
        submitInfo.waitSemaphoreInfoCount = 1;
        submitInfo.pWaitSemaphoreInfos = &waitSemInfo;
        submitInfo.commandBufferInfoCount = 1;
        submitInfo.pCommandBufferInfos = &cmdSubmitInfo;
        submitInfo.signalSemaphoreInfoCount = 2;
        submitInfo.pSignalSemaphoreInfos = signalSemInfos;

        vkQueueSubmit2(vkCtx.graphicsQueue, 1, &submitInfo, VK_NULL_HANDLE);

        // Optional automated GPU swapchain frame capture for visual round-trip verification
        if (const char* capPath = std::getenv("CNC_CAPTURE_PATH")) {
            static int s_capturedFrames = 0;
            static bool s_doneCapture = false;
            bool wantMenu = (std::getenv("CNC_CAPTURE_MENU") != nullptr);
            bool readyMode = wantMenu ? ultraMenuState.active : (tactical3DState.active && tactical3DState.ubo.view_params3[3] > 0.95f);
            if (!s_doneCapture && readyMode) {
                int targetFrame = 65;
                if (const char* tfEnv = std::getenv("CNC_CAPTURE_FRAME")) {
                    targetFrame = std::max(1, std::atoi(tfEnv));
                }
                if (++s_capturedFrames >= targetFrame) {
                    s_doneCapture = true;
                    vkDeviceWaitIdle(vkCtx.device);

                    VkDeviceSize bufSize = static_cast<VkDeviceSize>(vkCtx.swapchainWidth) * vkCtx.swapchainHeight * 4;
                    VkBuffer readBuf = VK_NULL_HANDLE;
                    VkDeviceMemory readMem = VK_NULL_HANDLE;
                    if (Create_Buffer(bufSize,
                                      VK_BUFFER_USAGE_TRANSFER_DST_BIT,
                                      VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT,
                                      readBuf,
                                      readMem)) {
                        vkResetCommandPool(vkCtx.device, fr.commandPool, 0);
                        VkCommandBufferBeginInfo capBegin{};
                        capBegin.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO;
                        capBegin.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
                        vkBeginCommandBuffer(fr.commandBuffer, &capBegin);

                        VkImageMemoryBarrier2 toSrc{};
                        toSrc.sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER_2;
                        toSrc.srcStageMask = VK_PIPELINE_STAGE_2_ALL_COMMANDS_BIT;
                        toSrc.srcAccessMask = VK_ACCESS_2_MEMORY_WRITE_BIT;
                        toSrc.dstStageMask = VK_PIPELINE_STAGE_2_TRANSFER_BIT;
                        toSrc.dstAccessMask = VK_ACCESS_2_TRANSFER_READ_BIT;
                        toSrc.oldLayout = VK_IMAGE_LAYOUT_PRESENT_SRC_KHR;
                        toSrc.newLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL;
                        toSrc.image = vkCtx.swapchainImages[imageIndex];
                        toSrc.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};

                        VkDependencyInfo depSrc{};
                        depSrc.sType = VK_STRUCTURE_TYPE_DEPENDENCY_INFO;
                        depSrc.imageMemoryBarrierCount = 1;
                        depSrc.pImageMemoryBarriers = &toSrc;
                        vkCmdPipelineBarrier2(fr.commandBuffer, &depSrc);

                        VkBufferImageCopy reg{};
                        reg.imageSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1};
                        reg.imageExtent = {vkCtx.swapchainWidth, vkCtx.swapchainHeight, 1};
                        vkCmdCopyImageToBuffer(fr.commandBuffer,
                                               vkCtx.swapchainImages[imageIndex],
                                               VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,
                                               readBuf,
                                               1,
                                               &reg);

                        VkImageMemoryBarrier2 backPres = toSrc;
                        backPres.srcStageMask = VK_PIPELINE_STAGE_2_TRANSFER_BIT;
                        backPres.srcAccessMask = VK_ACCESS_2_TRANSFER_READ_BIT;
                        backPres.dstStageMask = VK_PIPELINE_STAGE_2_NONE;
                        backPres.dstAccessMask = 0;
                        backPres.oldLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL;
                        backPres.newLayout = VK_IMAGE_LAYOUT_PRESENT_SRC_KHR;
                        vkCmdPipelineBarrier2(fr.commandBuffer, &depSrc);

                        vkEndCommandBuffer(fr.commandBuffer);

                        VkSubmitInfo capSub{};
                        capSub.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO;
                        capSub.commandBufferCount = 1;
                        capSub.pCommandBuffers = &fr.commandBuffer;
                        vkQueueSubmit(vkCtx.graphicsQueue, 1, &capSub, VK_NULL_HANDLE);
                        vkDeviceWaitIdle(vkCtx.device);

                        void* mapped = nullptr;
                        if (vkMapMemory(vkCtx.device, readMem, 0, bufSize, 0, &mapped) == VK_SUCCESS && mapped) {
                            FILE* fp = std::fopen(capPath, "wb");
                            if (fp) {
                                std::fprintf(fp, "P6\n%u %u\n255\n", vkCtx.swapchainWidth, vkCtx.swapchainHeight);
                                const uint8_t* px = static_cast<const uint8_t*>(mapped);
                                bool isBGRA = (vkCtx.swapchainFormat == VK_FORMAT_B8G8R8A8_UNORM ||
                                               vkCtx.swapchainFormat == VK_FORMAT_B8G8R8A8_SRGB);
                                size_t totalPx = static_cast<size_t>(vkCtx.swapchainWidth) * vkCtx.swapchainHeight;
                                std::vector<uint8_t> rgb(totalPx * 3);
                                for (size_t i = 0; i < totalPx; ++i) {
                                    rgb[i * 3 + 0] = isBGRA ? px[i * 4 + 2] : px[i * 4 + 0];
                                    rgb[i * 3 + 1] = px[i * 4 + 1];
                                    rgb[i * 3 + 2] = isBGRA ? px[i * 4 + 0] : px[i * 4 + 2];
                                }
                                std::fwrite(rgb.data(), 1, rgb.size(), fp);
                                std::fclose(fp);
                            }
                            vkUnmapMemory(vkCtx.device, readMem);
                        }
                        vkDestroyBuffer(vkCtx.device, readBuf, nullptr);
                        vkFreeMemory(vkCtx.device, readMem, nullptr);

                        if (std::getenv("CNC_CAPTURE_EXIT") != nullptr) {
                            std::_Exit(0);
                        }
                    }
                }
            }
        }

        VkPresentInfoKHR presentInfo{};
        presentInfo.sType = VK_STRUCTURE_TYPE_PRESENT_INFO_KHR;
        presentInfo.waitSemaphoreCount = 1;
        presentInfo.pWaitSemaphores = &vkCtx.renderCompleteSemaphores[imageIndex];
        presentInfo.swapchainCount = 1;
        presentInfo.pSwapchains = &vkCtx.swapchain;
        presentInfo.pImageIndices = &imageIndex;

        VkResult pres = vkQueuePresentKHR(vkCtx.graphicsQueue, &presentInfo);
        if (pres == VK_ERROR_OUT_OF_DATE_KHR || pres == VK_SUBOPTIMAL_KHR) {
            vkCtx.requireSwapchainRecreate = true;
        }
    }

private:
    int width;
    int height;
    GBC_Enum flags;
    uint8_t* buffer;
};

/*=========================================================================*/
/* Video Factory Singleton                                                 */
/*=========================================================================*/
Video::Video() {}
Video::~Video() {}

Video& Video::Shared()
{
    static Video video;
    return video;
}

VideoSurface* Video::CreateSurface(int w, int h, GBC_Enum flags)
{
    return new VideoSurfaceVulkan(w, h, flags);
}

/*=========================================================================*/
/* Public Video Lifecycle, Palette & Input API                             */
/*=========================================================================*/
bool Set_Video_Mode(int w, int h, int bits_per_pixel)
{
    (void)bits_per_pixel;
    SDL_Init(SDL_INIT_VIDEO | SDL_INIT_EVENTS);
    SDL_ShowCursor(SDL_DISABLE);

    int win_w = w;
    int win_h = h;
    Uint32 win_flags = SDL_WINDOW_VULKAN;

    if (!Settings.Video.Windowed) {
        if (Settings.Video.Width < w || Settings.Video.Height < h) {
            win_w = w * 2;
            win_h = h * 2;
            Settings.Video.Width = 0;
            Settings.Video.Height = 0;
            win_flags |= SDL_WINDOW_FULLSCREEN_DESKTOP | SDL_WINDOW_RESIZABLE;
        } else {
            win_w = Settings.Video.Width;
            win_h = Settings.Video.Height;
            win_flags |= SDL_WINDOW_FULLSCREEN;
        }
    } else if (Settings.Video.WindowWidth > w || Settings.Video.WindowHeight > h) {
        win_w = Settings.Video.WindowWidth;
        win_h = Settings.Video.WindowHeight;
        win_flags |= SDL_WINDOW_RESIZABLE;
    } else {
        Settings.Video.WindowWidth = win_w;
        Settings.Video.WindowHeight = win_h;
        win_flags |= SDL_WINDOW_RESIZABLE;
    }

    if (window != nullptr) {
        Shutdown_Vulkan_Backend();
        SDL_DestroyWindow(window);
        window = nullptr;
    }

    window = SDL_CreateWindow(
        "Vanilla Conquer", SDL_WINDOWPOS_UNDEFINED, SDL_WINDOWPOS_UNDEFINED, win_w, win_h, win_flags);

    if (window == nullptr) {
        DBG_ERROR("SDL_CreateWindow (Vulkan) failed: %s", SDL_GetError());
        return false;
    }

    if (palette == nullptr) {
        palette = SDL_AllocPalette(256);
    }

    if (!Initialize_Vulkan_Backend(w, h)) {
        DBG_WARN("Vulkan 1.3 initialization unavailable; running in software surface fallback mode.");
    } else {
        DBG_INFO("Initialized Vulkan 1.3 presentation backend (%dx%d swapchain)",
                 vkCtx.swapchainWidth,
                 vkCtx.swapchainHeight);
    }

    hwcursor.GameW = w;
    hwcursor.GameH = h;
    hwcursor.X = static_cast<float>(w / 2);
    hwcursor.Y = static_cast<float>(h / 2);
    Update_HWCursor_Settings();

    if (Settings.Mouse.ControllerEnabled && Keyboard) {
        SDL_Init(SDL_INIT_GAMECONTROLLER);
        Keyboard->Open_Controller();
    }

    return true;
}

void Reset_Video_Mode(void)
{
    if (hwcursor.Pending) {
        SDL_FreeCursor(hwcursor.Pending);
        hwcursor.Pending = nullptr;
    }

    if (hwcursor.Current) {
        SDL_FreeCursor(hwcursor.Current);
        hwcursor.Current = nullptr;
    }

    if (hwcursor.Surface) {
        SDL_FreeSurface(hwcursor.Surface);
        hwcursor.Surface = nullptr;
    }

    Shutdown_Vulkan_Backend();

    if (palette) {
        SDL_FreePalette(palette);
        palette = nullptr;
    }

    if (window) {
        SDL_DestroyWindow(window);
        window = nullptr;
    }

    if (Keyboard) {
        Keyboard->Close_Controller();
    }
}

void Toggle_Video_Fullscreen()
{
    Settings.Video.Windowed = !Settings.Video.Windowed;

    if (window) {
        if (!Settings.Video.Windowed) {
            if (Settings.Video.Width == 0 || Settings.Video.Height == 0) {
                SDL_SetWindowFullscreen(window, SDL_WINDOW_FULLSCREEN_DESKTOP);
            } else {
                SDL_SetWindowSize(window, Settings.Video.Width, Settings.Video.Height);
                SDL_SetWindowFullscreen(window, SDL_WINDOW_FULLSCREEN);
            }
        } else {
            SDL_SetWindowFullscreen(window, 0);
            SDL_SetWindowSize(window, Settings.Video.WindowWidth, Settings.Video.WindowHeight);
        }
    }

    vkCtx.requireSwapchainRecreate = true;
    Update_HWCursor_Settings();
}

void Get_Video_Scale(float& x, float& y)
{
    x = hwcursor.ScaleX;
    y = hwcursor.ScaleY;
}

void Set_Video_Cursor_Clip(bool clipped)
{
    hwcursor.Clip = clipped;

    if (window) {
        int relative = 0;

        if (Settings.Video.Windowed) {
            bool grab = Settings.Mouse.RawInput && hwcursor.Clip;
            SDL_SetWindowGrab(window, grab ? SDL_TRUE : SDL_FALSE);
            relative = SDL_SetRelativeMouseMode(Settings.Mouse.ControllerEnabled || grab ? SDL_TRUE : SDL_FALSE);

            if (Settings.Mouse.RawInput) {
                if (hwcursor.Clip) {
                    int x = 0, y = 0;
                    SDL_GetMouseState(&x, &y);
                    hwcursor.X = x / hwcursor.ScaleX;
                    hwcursor.Y = y / hwcursor.ScaleY;
                } else {
                    SDL_WarpMouseInWindow(window,
                                          static_cast<int>(hwcursor.X * hwcursor.ScaleX),
                                          static_cast<int>(hwcursor.Y * hwcursor.ScaleY));
                }
            }
        } else {
            SDL_SetWindowGrab(window, Settings.Mouse.RawInput ? SDL_TRUE : SDL_FALSE);
            relative = SDL_SetRelativeMouseMode(Settings.Mouse.RawInput ? SDL_TRUE : SDL_FALSE);
        }

        if (relative < 0) {
            DBG_ERROR("Raw input not supported, disabling.");
            Settings.Mouse.RawInput = false;
        }
    }
}

void Move_Video_Mouse(float xrel, float yrel)
{
    if ((Keyboard && Keyboard->Is_Gamepad_Active()) ||
        (Settings.Mouse.RawInput && (hwcursor.Clip || !Settings.Video.Windowed))) {
        hwcursor.X += xrel * (Settings.Mouse.Sensitivity / 100.0f);
        hwcursor.Y += yrel * (Settings.Mouse.Sensitivity / 100.0f);
    }

    if (hwcursor.X >= hwcursor.GameW) {
        hwcursor.X = static_cast<float>(hwcursor.GameW - 1);
    } else if (hwcursor.X < 0) {
        hwcursor.X = 0.0f;
    }

    if (hwcursor.Y >= hwcursor.GameH) {
        hwcursor.Y = static_cast<float>(hwcursor.GameH - 1);
    } else if (hwcursor.Y < 0) {
        hwcursor.Y = 0.0f;
    }
}

void Get_Video_Mouse(int& x, int& y)
{
    if ((Keyboard && Keyboard->Is_Gamepad_Active()) ||
        (Settings.Mouse.RawInput && (hwcursor.Clip || !Settings.Video.Windowed))) {
        x = static_cast<int>(hwcursor.X);
        y = static_cast<int>(hwcursor.Y);
    } else {
        SDL_GetMouseState(&x, &y);
        int win_w = 0, win_h = 0;
        if (window) {
            SDL_GetWindowSize(window, &win_w, &win_h);
        }
        SDL_Rect mouse_dst{};
        Compute_Letterbox_Rect(win_w, win_h, hwcursor.GameW, hwcursor.GameH, mouse_dst);
        if (mouse_dst.w > 0 && mouse_dst.h > 0) {
            x = (x - mouse_dst.x) * hwcursor.GameW / mouse_dst.w;
            y = (y - mouse_dst.y) * hwcursor.GameH / mouse_dst.h;
        } else {
            float scale_x = 1.0f, scale_y = 1.0f;
            Get_Video_Scale(scale_x, scale_y);
            x = static_cast<int>(x / (scale_x > 0.0f ? scale_x : 1.0f));
            y = static_cast<int>(y / (scale_y > 0.0f ? scale_y : 1.0f));
        }
        if (x >= hwcursor.GameW) x = hwcursor.GameW - 1;
        if (x < 0) x = 0;
        if (y >= hwcursor.GameH) y = hwcursor.GameH - 1;
        if (y < 0) y = 0;
    }
}

void Set_Video_Cursor(void* cursor, int w, int h, int hotx, int hoty)
{
    hwcursor.Raw = cursor;
    hwcursor.W = w;
    hwcursor.H = h;
    hwcursor.HotX = hotx;
    hwcursor.HotY = hoty;

    Update_HWCursor();
}

unsigned int Get_Free_Video_Memory(void)
{
    return 1000000000;
}

unsigned Get_Video_Hardware_Capabilities(void)
{
    return VIDEO_BLITTER;
}

void Wait_Vert_Blank(void)
{
}

void Wait_Blit(void)
{
}

void Set_DD_Palette(void* rpalette)
{
    if (!rpalette) return;

    SDL_Color colors[256];
    const unsigned char* rcolors = static_cast<const unsigned char*>(rpalette);

    for (int i = 0; i < 256; i++) {
        uint8_t r8 = static_cast<uint8_t>(rcolors[i * 3] << 2);
        uint8_t g8 = static_cast<uint8_t>(rcolors[i * 3 + 1] << 2);
        uint8_t b8 = static_cast<uint8_t>(rcolors[i * 3 + 2] << 2);

        colors[i].r = r8;
        colors[i].g = g8;
        colors[i].b = b8;
        colors[i].a = (i == 0) ? 0 : 0xFF;

        vkCtx.currentPalette.colors[i][0] = static_cast<float>(r8) / 255.0f;
        vkCtx.currentPalette.colors[i][1] = static_cast<float>(g8) / 255.0f;
        vkCtx.currentPalette.colors[i][2] = static_cast<float>(b8) / 255.0f;
        vkCtx.currentPalette.colors[i][3] = (i == 0) ? 0.0f : 1.0f;
    }

    if (palette) {
        SDL_SetPaletteColors(palette, colors, 0, 256);
    }

    Update_HWCursor();
}

void Video_Render_Frame()
{
    if (frontSurface) {
        frontSurface->RenderSurface();
    }
}

static void Pack_ASCII_To_UVec4_Pair(const char* str, uint32_t outWords[2][4], int& outLen)
{
    std::memset(outWords, 0, sizeof(uint32_t) * 8);
    outLen = 0;
    if (!str) return;
    while (str[outLen] != '\0' && outLen < 32) {
        uint8_t ch = static_cast<uint8_t>(str[outLen]);
        int wordIdx = outLen >> 2;
        int byteShift = (outLen & 3) * 8;
        outWords[wordIdx >> 2][wordIdx & 3] |= (static_cast<uint32_t>(ch) << byteShift);
        outLen++;
    }
}

void Video_Set_Ultra_Menu_State(bool active,
                                const UltraMenuButtonInfo* buttons,
                                int button_count,
                                const char* version_text,
                                int mode)
{
    if (active && !ultraMenuState.active) {
        ultraMenuState.startTime = std::chrono::steady_clock::now();
    }
    ultraMenuState.active = active;
    if (!active) {
        return;
    }

    int count = std::max(0, std::min(button_count, 8));
    ultraMenuState.ubo.params1[0] = static_cast<float>(count);
    ultraMenuState.ubo.params1[3] = 1.0f;
    ultraMenuState.ubo.ver_info[1] = static_cast<float>(mode);

    for (int i = 0; i < count && buttons != nullptr; ++i) {
        const UltraMenuButtonInfo& b = buttons[i];
        ultraMenuState.ubo.btn_rect[i][0] = b.x;
        ultraMenuState.ubo.btn_rect[i][1] = b.y;
        ultraMenuState.ubo.btn_rect[i][2] = b.x + b.w;
        ultraMenuState.ubo.btn_rect[i][3] = b.y + b.h;

        float targetHover = b.hover;
        ultraMenuState.smoothHover[i] += (targetHover - ultraMenuState.smoothHover[i]) * 0.22f;

        int charLen = 0;
        Pack_ASCII_To_UVec4_Pair(b.label, &ultraMenuState.ubo.btn_chars[i * 2], charLen);

        ultraMenuState.ubo.btn_state[i][0] = ultraMenuState.smoothHover[i];
        ultraMenuState.ubo.btn_state[i][1] = b.selected ? 1.0f : 0.0f;
        ultraMenuState.ubo.btn_state[i][2] = b.pressed ? 1.0f : 0.0f;
        ultraMenuState.ubo.btn_state[i][3] = static_cast<float>(charLen);
    }

    int verLen = 0;
    Pack_ASCII_To_UVec4_Pair(version_text, ultraMenuState.ubo.ver_chars, verLen);
    ultraMenuState.ubo.ver_info[0] = static_cast<float>(verLen);
}

void Video_Set_Tactical_3D_State(bool active, const Tactical3DUBOData* data)
{
    if (active && !tactical3DState.active) {
        tactical3DState.startTime = std::chrono::steady_clock::now();
    }
    tactical3DState.active = active;
    if (active && data != nullptr) {
        tactical3DState.ubo = *data;
    }
}

void Video_Set_Tactical_Dialog_Rect(int x, int y, int w, int h)
{
    int gw = hwcursor.GameW > 0 ? hwcursor.GameW : 640;
    int gh = hwcursor.GameH > 0 ? hwcursor.GameH : 400;
    if (w > 0 && h > 0) {
        float u0 = static_cast<float>(x) / static_cast<float>(gw);
        float v0 = static_cast<float>(y) / static_cast<float>(gh);
        float u1 = static_cast<float>(x + w) / static_cast<float>(gw);
        float v1 = static_cast<float>(y + h) / static_cast<float>(gh);
        if (tactical3DState.dialogRect[2] > tactical3DState.dialogRect[0] &&
            tactical3DState.dialogRect[3] > tactical3DState.dialogRect[1]) {
            tactical3DState.dialogRect[0] = std::min(tactical3DState.dialogRect[0], u0);
            tactical3DState.dialogRect[1] = std::min(tactical3DState.dialogRect[1], v0);
            tactical3DState.dialogRect[2] = std::max(tactical3DState.dialogRect[2], u1);
            tactical3DState.dialogRect[3] = std::max(tactical3DState.dialogRect[3], v1);
        } else {
            tactical3DState.dialogRect[0] = u0;
            tactical3DState.dialogRect[1] = v0;
            tactical3DState.dialogRect[2] = u1;
            tactical3DState.dialogRect[3] = v1;
        }
    } else {
        tactical3DState.dialogRect[0] = 0.0f;
        tactical3DState.dialogRect[1] = 0.0f;
        tactical3DState.dialogRect[2] = -1.0f;
        tactical3DState.dialogRect[3] = -1.0f;
    }
}

