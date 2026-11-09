#ifndef VIDEO_H
#define VIDEO_H

#include "rect.h"
#include <cstdint>

enum GBC_Enum
{
    GBC_NONE = 0,
    GBC_VIDEOMEM = 1,
    GBC_VISIBLE = 2,
};

class VideoSurface;

class Video
{
public:
    Video();
    virtual ~Video();

    static Video& Shared();

    VideoSurface* CreateSurface(int w, int h, GBC_Enum flags);
};

class VideoSurface
{
public:
    virtual ~VideoSurface()
    {
    }

    virtual void* GetData() const = 0;
    virtual int GetPitch() const = 0;
    virtual bool IsAllocated() const = 0;

    virtual void AddAttachedSurface(VideoSurface* surface) = 0;
    virtual bool IsReadyToBlit() = 0;
    virtual bool LockWait() = 0;
    virtual bool Unlock() = 0;
    virtual void Blt(const Rect& destRect, VideoSurface* src, const Rect& srcRect, bool mask) = 0;
    virtual void FillRect(const Rect& rect, unsigned char color) = 0;
};

class SurfaceMonitorClass
{
public:
    SurfaceMonitorClass();
    virtual ~SurfaceMonitorClass()
    {
    }

    virtual void Restore_Surfaces() = 0;
    virtual void Set_Surface_Focus(bool in_focus) = 0;
    virtual void Release() = 0;

    bool SurfacesRestored;
};

extern SurfaceMonitorClass& AllSurfaces; // List of all surfaces

bool Set_Video_Mode(int w, int h, int bits_per_pixel);
void Get_Video_Scale(float& x, float& y);
void Set_Video_Cursor_Clip(bool clipped);
void Move_Video_Mouse(float xrel, float yrel);
void Get_Video_Mouse(int& x, int& y);
void Toggle_Video_Fullscreen();
void Reset_Video_Mode();
unsigned Get_Free_Video_Memory();
void Wait_Blit();

/*
** Set desired cursor image in game palette.
*/
void Set_Video_Cursor(void* cursor, int w, int h, int hotx, int hoty);

/*
 *  Flags returned by Get_Video_Hardware_Capabilities
 */
/* Hardware blits supported? */
#define VIDEO_BLITTER 1

/* Hardware blits asyncronous? */
#define VIDEO_BLITTER_ASYNC 2

/* Can palette changes be synced to vertical refresh? */
#define VIDEO_SYNC_PALETTE 4

/* Is the video cards memory bank switched? */
#define VIDEO_BANK_SWITCHED 8

/* Can the blitter do filled rectangles? */
#define VIDEO_COLOR_FILL 16

/* Is there no hardware assistance avaailable at all? */
#define VIDEO_NO_HARDWARE_ASSIST 32

unsigned Get_Video_Hardware_Capabilities();

void Wait_Vert_Blank();
void Set_DD_Palette(void* palette);

struct UltraMenuButtonInfo
{
    float x;
    float y;
    float w;
    float h;
    const char* label;
    float hover;
    bool selected;
    bool pressed;
};

void Video_Set_Ultra_Menu_State(bool active,
                                const UltraMenuButtonInfo* buttons = nullptr,
                                int button_count = 0,
                                const char* version_text = nullptr,
                                int mode = 1);

struct Tactical3DUBOData
{
    float view_params0[4];        // x=time, y=tac_u0, z=tac_v0, w=tac_u1
    float view_params1[4];        // x=tac_v1, y=sub_cell_x, z=sub_cell_y, w=cells_wide
    float view_params2[4];        // x=cells_high, y=origin_cell_x, z=origin_cell_y, w=theater
    float view_params3[4];        // x=entity_count, y=light_count, z=player_house, w=palette_fade
    float overlay_rects[4][4];    // [0]=rubber_band, [1]=dialog_rect, [2]=tooltip_rect, [3]=aux_ui
    uint32_t cell_grid[150][4];   // 30 x 20 cells = 600 uints
    float ent_data0[128][4];      // x=wx, y=wy, z=alt, w=packed_type
    float ent_data1[128][4];      // x=hull_yaw, y=turret_yaw, z=health_and_flags, w=footprint_and_aux
    float light_pos_rad[32][4];   // x=wx, y=wy, z=wz, w=radius
    float light_col_int[32][4];   // x=r, y=g, z=b, w=intensity
};

void Video_Set_Tactical_3D_State(bool active, const Tactical3DUBOData* data = nullptr);
void Video_Set_Tactical_Dialog_Rect(int x, int y, int w, int h);

#endif // VIDEO_H
