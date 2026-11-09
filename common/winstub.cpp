//
// Copyright 2020 Electronic Arts Inc.
//
// TiberianDawn.DLL and RedAlert.dll and corresponding source code is free
// software: you can redistribute it and/or modify it under the terms of
// the GNU General Public License as published by the Free Software Foundation,
// either version 3 of the License, or (at your option) any later version.

// TiberianDawn.DLL and RedAlert.dll and corresponding source code is distributed
// in the hope that it will be useful, but with permitted additional restrictions
// under Section 7 of the GPL. See the GNU General Public License in LICENSE.TXT
// distributed with this program. You should have received a copy of the
// GNU General Public License along with permitted additional restrictions
// with this program. If not, see https://github.com/electronicarts/CnC_Remastered_Collection

/***********************************************************************************************
 ***              C O N F I D E N T I A L  ---  W E S T W O O D  S T U D I O S               ***
 ************************************************************************************************/

#include "winstub.h"

#include "iff.h"
#include "gbuffer.h"
#include "filepcx.h"
#include "debugstring.h"

/***********************************************************************************************
 * Load_Title_Screen -- loads the title screen into the given video buffer                     *
 *                                                                                             *
 *                                                                                             *
 *                                                                                             *
 * INPUT:    screen name                                                                       *
 *           video buffer                                                                      *
 *           ptr to buffer for palette                                                         *
 *                                                                                             *
 * OUTPUT:   Nothing                                                                           *
 *                                                                                             *
 * WARNINGS: None                                                                              *
 *                                                                                             *
 * HISTORY:                                                                                    *
 *    7/5/96 11:30AM ST : Created                                                              *
 *=============================================================================================*/

void Load_Title_Screen(const char* name, GraphicViewPortClass* video_page, unsigned char* palette)
{
    GraphicBufferClass* load_buffer;
    const char* ext = strrchr(name, '.');

    if (!strcasecmp(ext, ".PCX"))
        load_buffer = Read_PCX_File(name, (char*)palette, NULL, 0); // Load 640x400 title
    else if (!strcasecmp(ext, ".CPS")) {
        /* CPS files are hardcoded to 320x200. */
        const int width = 320;
        const int height = 200;

        load_buffer = new GraphicBufferClass(width, height, NULL, width * (height + 4));
        Load_Uncompress(name, *load_buffer, *load_buffer, palette);
    } else {
        /* Invalid title screen. */
        DBG_ERROR("Title screen file %s do not have PCX or CPS extension", name);
    }

    DBG_INFO("Load_Title_Screen('%s'): load_buffer=%p", name, (void*)load_buffer);
    if (load_buffer) {
        int dst_w = video_page->Get_Width();
        int dst_h = video_page->Get_Height();
        int src_w = load_buffer->Get_Width();
        int src_h = load_buffer->Get_Height();
        if (dst_w > src_w || dst_h > src_h) {
            video_page->Clear();
            int x_off = (dst_w > src_w) ? ((dst_w - src_w) / 2) : 0;
            int y_off = (dst_h > src_h) ? ((dst_h - src_h) / 2) : 0;
            load_buffer->Blit(*video_page, 0, 0, x_off, y_off, src_w, src_h);
        } else {
            load_buffer->Blit(*video_page);
        }
        delete load_buffer;
    }
}
