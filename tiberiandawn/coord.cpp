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

/* $Header:   F:\projects\c&c\vcs\code\coord.cpv   2.18   16 Oct 1995 16:51:24   JOE_BOSTIC  $ */
/***********************************************************************************************
 ***             C O N F I D E N T I A L  ---  W E S T W O O D   S T U D I O S               ***
 ***********************************************************************************************
 *                                                                                             *
 *                 Project Name : Command & Conquer                                            *
 *                                                                                             *
 *                    File Name : COORD.CPP                                                    *
 *                                                                                             *
 *                   Programmer : Joe L. Bostic                                                *
 *                                                                                             *
 *                   Start Date : September 10, 1993                                           *
 *                                                                                             *
 *                  Last Update : January 7, 1995 [JLB]                                        *
 *                                                                                             *
 * Support code to handle the coordinate system is located in this module.                     *
 * Routines here will be called QUITE frequently during play and must be                       *
 * as efficient as possible.                                                                   *
 *                                                                                             *
 *---------------------------------------------------------------------------------------------*
 * Functions:                                                                                  *
 *   Cardinal_To_Fixed -- Converts cardinal numbers into a fixed point number.                 *
 *   Coord_Move -- Moves a coordinate an arbitrary direction for an arbitrary distance         *
 *   Coord_Scatter -- Determines a random coordinate from an anchor point.                     *
 *   Coord_Spillage_List -- Determines the offset list for cell spillage/occupation.           *
 *   Fixed_To_Cardinal -- Converts a fixed point number into a cardinal number.                *
 * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - */

#include "function.h"
#include "cnc_lean_ffi.h"

/***********************************************************************************************
 * Coord_Cell -- Convert a coordinate into a cell number.                                      *
 *                                                                                             *
 *    This routine will convert the specified coordinate value into a cell number. This is     *
 *    useful to determine the map index number into the cell array that corresponds to a       *
 *    particular coordinate.                                                                   *
 *                                                                                             *
 * INPUT:   coord -- The coordinate to convert into a cell number.                             *
 *                                                                                             *
 * OUTPUT:  Returns with the cell number that corresponds to the coordinate specified.         *
 *                                                                                             *
 * WARNINGS:   none                                                                            *
 *                                                                                             *
 * HISTORY:                                                                                    *
 *   06/17/1996 JLB : Created.                                                                 *
 *=============================================================================================*/
CELL Coord_Cell(COORDINATE coord)
{
#ifdef MEGAMAPS
    return static_cast<CELL>(cnc_lean_coord_cell(static_cast<uint32_t>(coord)));
#else
    return static_cast<CELL>(cnc_lean_coord_cell_64(static_cast<uint32_t>(coord)));
#endif
}

/***********************************************************************************************
 * Distance -- Determines the lepton distance between two coordinates.                         *
 *                                                                                             *
 *    This routine is used to determine the distance between two coordinates. It uses the      *
 *    Dragon Strike method of distance determination and thus it is very fast.                 *
 *                                                                                             *
 * INPUT:   coord1   -- First coordinate.                                                      *
 *                                                                                             *
 *          coord2   -- Second coordinate.                                                     *
 *                                                                                             *
 * OUTPUT:  Returns the lepton distance between the two coordinates.                           *
 *                                                                                             *
 * WARNINGS:   none                                                                            *
 *                                                                                             *
 * HISTORY:                                                                                    *
 *   05/27/1994 JLB : Created.                                                                 *
 *=============================================================================================*/
int Distance_Coord(COORDINATE coord1, COORDINATE coord2)
{
    return static_cast<int>(cnc_lean_distance_coord(static_cast<uint32_t>(coord1), static_cast<uint32_t>(coord2)));
}

/***********************************************************************************************
 * Coord_Spillage_List -- Determines the offset list for cell spillage/occupation.             *
 *                                                                                             *
 *    This routine will take an arbitrary position and object size and return with a list of   *
 *    cell offsets from the current cell for all cells that are overlapped by the object. The  *
 *    first cell offset is always zero, so to just get the adjacent spill cell list, add one   *
 *    to the return pointer.                                                                   *
 *                                                                                             *
 * INPUT:   coord -- The coordinate to examine.                                                *
 *                                                                                             *
 *          maxsize -- The maximum width/height of the object (pixels).                        *
 *                                                                                             *
 * OUTPUT:  Returns with a pointer to a spillage list.                                         *
 *                                                                                             *
 * WARNINGS:   The algorithm is limited to working with a maxsize of 48 or less. Larger values *
 *             will generate an incomplete overlap list.                                       *
 *                                                                                             *
 * HISTORY:                                                                                    *
 *   11/06/1993 JLB : Created.                                                                 *
 *   03/25/1994 JLB : Added width optimization.                                                *
 *   04/29/1994 JLB : Converted to C.                                                          *
 *   06/03/1994 JLB : Converted to general purpose spillage functionality.                     *
 *   01/07/1995 JLB : Manually calculates spillage list for large objects.                     *
 *=============================================================================================*/
short const* Coord_Spillage_List(COORDINATE coord, int maxsize)
{
    static short const _MoveSpillage[(int)FACING_COUNT + 1][5] = {
        {0, -MAP_CELL_W, REFRESH_EOL, 0, 0},                  // N
        {0, -MAP_CELL_W, 1, -(MAP_CELL_W - 1), REFRESH_EOL},  // NE
        {0, 1, REFRESH_EOL, 0, 0},                            // E
        {0, 1, MAP_CELL_W, MAP_CELL_W + 1, REFRESH_EOL},      // SE
        {0, MAP_CELL_W, REFRESH_EOL, 0, 0},                   // S
        {0, -1, MAP_CELL_W, MAP_CELL_W - 1, REFRESH_EOL},     // SW
        {0, -1, REFRESH_EOL, 0, 0},                           // W
        {0, -1, -MAP_CELL_W, -(MAP_CELL_W + 1), REFRESH_EOL}, // NW
        {0, REFRESH_EOL, 0, 0, 0}                             // non-moving.
        //		{0, -MAP_CELL_W, -(MAP_CELL_W-1), 1, MAP_CELL_W+1, MAP_CELL_W, MAP_CELL_W-1, -1, -(MAP_CELL_W+1),
        //REFRESH_EOL}
    };
    static short _manual[10];
    //;	00 = on axis
    //;	01 = below axis
    //;	10 = above axis
    //;	11 = undefined
    static char const _SpillTable[16] = {8, 6, 2, -1, 0, 7, 1, -1, 4, 5, 3, -1, -1, -1, -1, -1};
    int index = 0;
    int x, y;

    /*
    **	For mondo-enourmo-gigundo objects, use a prebuilt mammoth table
    **	that covers a 5x5 square region.
    */
    if (maxsize > ICON_PIXEL_W * 2) {
        static short const _gigundo[] = {-((2 * MAP_CELL_W) - 2), -((2 * MAP_CELL_W) - 1),
                                         -((2 * MAP_CELL_W)),     -((2 * MAP_CELL_W) + 1),
                                         -((2 * MAP_CELL_W) + 2), -((1 * MAP_CELL_W) - 2),
                                         -((1 * MAP_CELL_W) - 1), -((1 * MAP_CELL_W)),
                                         -((1 * MAP_CELL_W) + 1), -((1 * MAP_CELL_W) + 2),
                                         -((0 * MAP_CELL_W) - 2), -((0 * MAP_CELL_W) - 1),
                                         -((0 * MAP_CELL_W)),     -((0 * MAP_CELL_W) + 1),
                                         -((0 * MAP_CELL_W) + 2), ((1 * MAP_CELL_W) - 2),
                                         ((1 * MAP_CELL_W) - 1),  ((1 * MAP_CELL_W)),
                                         ((1 * MAP_CELL_W) + 1),  ((1 * MAP_CELL_W) + 2),
                                         +((2 * MAP_CELL_W) - 2), +((2 * MAP_CELL_W) - 1),
                                         +((2 * MAP_CELL_W)),     +((2 * MAP_CELL_W) + 1),
                                         +((2 * MAP_CELL_W) + 2), REFRESH_EOL};
        return (&_gigundo[0]);
    }

    /*
    **	For very large objects, build the overlap list by hand. This is time consuming, but
    **	not nearly as time consuming as drawing even a single cell unnecessarily.
    */
    if (maxsize > ICON_PIXEL_W) {
        maxsize = MIN(maxsize, (ICON_PIXEL_W * 2)) / 2;

        x = Fixed_To_Cardinal(ICON_PIXEL_W, Coord_XLepton(coord));
        y = Fixed_To_Cardinal(ICON_PIXEL_H, Coord_YLepton(coord));
        int left = x - maxsize;
        int right = x + maxsize;
        int top = y - maxsize;
        int bottom = y + maxsize;

        _manual[index++] = 0;
        if (left < 0)
            _manual[index++] = -1;
        if (right >= ICON_PIXEL_W)
            _manual[index++] = 1;
        if (top < 0)
            _manual[index++] = -MAP_CELL_W;
        if (bottom >= ICON_PIXEL_H)
            _manual[index++] = MAP_CELL_W;
        if (left < 0 && top < 0)
            _manual[index++] = -(MAP_CELL_W + 1);
        if (right >= ICON_PIXEL_W && bottom >= ICON_PIXEL_H)
            _manual[index++] = MAP_CELL_W + 1;
        if (left < 0 && bottom >= ICON_PIXEL_H)
            _manual[index++] = MAP_CELL_W - 1;
        if (right >= ICON_PIXEL_H && top < 0)
            _manual[index++] = -(MAP_CELL_W - 1);
        _manual[index] = REFRESH_EOL;
        return (&_manual[0]);
    }

    /*
    **	Determine the number of leptons "leeway" allowed this unit.
    */
    int posval = Pixel2Lepton[(ICON_PIXEL_W - maxsize) / 2];

    x = Coord_XLepton(coord) - 0x0080;
    y = Coord_YLepton(coord) - 0x0080;
    if (y > posval)
        index |= 0x08; // Spilling South.
    if (y < -posval)
        index |= 0x04; // Spilling North.
    if (x > posval)
        index |= 0x02; // Spilling East.
    if (x < -posval)
        index |= 0x01; // Spilling West.

    return (&_MoveSpillage[_SpillTable[index]][0]);
}

/***********************************************************************************************
 * Coord_Move -- Moves a coordinate an arbitrary direction for an arbitrary distance           *
 *                                                                                             *
 *    This function will move a coordinate in a using SIN and COS arithmetic.                  *
 *                                                                                             *
 * INPUT:   start    -- The starting coordinate.                                               *
 *                                                                                             *
 *          dir      -- The direction to move the coordinate.                                  *
 *                                                                                             *
 *          distance -- The distance to move the coordinate position (in leptons).             *
 *                                                                                             *
 * OUTPUT:  Returns the new coordinate position.                                               *
 *                                                                                             *
 * WARNINGS:   This routine uses multiplies -- use with caution.                               *
 *                                                                                             *
 * HISTORY:                                                                                    *
 *   05/27/1994 JLB : Created.                                                                 *
 *=============================================================================================*/
COORDINATE Coord_Move(COORDINATE start, register DirType dir, unsigned short distance)
{
    return static_cast<COORDINATE>(
        cnc_lean_coord_move(static_cast<uint32_t>(start), static_cast<uint8_t>(dir), static_cast<uint16_t>(distance)));
}

/***********************************************************************************************
 * Coord_Scatter -- Determines a random coordinate from an anchor point.                       *
 *                                                                                             *
 *    This routine will perform a scatter algorithm on the specified                           *
 *    anchor point in order to return with another coordinate that is                          *
 *    randomly nearby the original. Typical use of this would be for                           *
 *    missile targeting.                                                                       *
 *                                                                                             *
 * INPUT:   coord    -- This is the anchor coordinate.                                         *
 *                                                                                             *
 *          distance -- This is the distance in pixels that the scatter                        *
 *                      should fall within.                                                    *
 *                                                                                             *
 *          lock     -- bool; Convert the new coordinate into a center                         *
 *                      cell based coordinate?                                                 *
 *                                                                                             *
 * OUTPUT:  Returns with a new coordinate that is nearby the original.                         *
 *                                                                                             *
 * WARNINGS:   Maximum pixel scatter distance is 255.                                          *
 *                                                                                             *
 * HISTORY:                                                                                    *
 *   02/01/1992 JLB : Created.                                                                 *
 *   05/13/1992 JLB : Only uses Random().                                                      *
 *=============================================================================================*/
COORDINATE Coord_Scatter(COORDINATE coord, unsigned distance, bool lock)
{
    COORDINATE newcoord;

    newcoord = Coord_Move(coord, Random_Pick(DIR_N, DIR_MAX), distance);
    if (newcoord & HIGH_COORD_MASK) {
        newcoord = coord;
    }

    if (lock) {
        newcoord = Coord_Snap(newcoord);
    }

    return (newcoord);
}

void Move_Point(short& x, short& y, register DirType dir, unsigned short distance)
{
    x = static_cast<short>(
        cnc_lean_move_point_x(static_cast<uint16_t>(x), static_cast<uint8_t>(dir), static_cast<uint16_t>(distance)));
    y = static_cast<short>(
        cnc_lean_move_point_y(static_cast<uint16_t>(y), static_cast<uint8_t>(dir), static_cast<uint16_t>(distance)));
}
