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

/* $Header:   F:\projects\c&c\vcs\code\special.cpv   1.4   16 Oct 1995 16:50:06   JOE_BOSTIC  $ */
/***********************************************************************************************
 ***              C O N F I D E N T I A L  ---  W E S T W O O D  S T U D I O S               ***
 ***********************************************************************************************
 *                                                                                             *
 *                 Project Name : Command & Conquer                                            *
 *                                                                                             *
 *                    File Name : SPECIAL.CPP                                                  *
 *                                                                                             *
 *                   Programmer : Joe L. Bostic                                                *
 *                                                                                             *
 *                   Start Date : 05/27/95                                                     *
 *                                                                                             *
 *                  Last Update : May 27, 1995 [JLB]                                           *
 *                                                                                             *
 *---------------------------------------------------------------------------------------------*
 * Functions:                                                                                  *
 * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - */

#include "function.h"
#include "common/framelimit.h"

#define OPTION_WIDTH  236
#define OPTION_HEIGHT 162
#define OPTION_X      ((320 - OPTION_WIDTH) / 2)
#define OPTION_Y      (200 - OPTION_HEIGHT) / 2

void Special_Dialog(void)
{
    SpecialClass oldspecial = Special;
    GadgetClass* buttons = NULL;
    static struct
    {
        int Description;
        int Setting;
        CheckBoxClass* Button;
    } _options[] = {
        //		{TXT_DEFENDER_ADVANTAGE, 0, 0},
        {TXT_SEPARATE_HELIPAD, 0, 0},
        {TXT_VISIBLE_TARGET, 0, 0},
        {TXT_TREE_TARGET, 0, 0},
        {TXT_MCV_DEPLOY, 0, 0},
        {TXT_SMART_DEFENCE, 0, 0},
        {TXT_THREE_POINT, 0, 0},
        //		{TXT_TIBERIUM_GROWTH, 0, 0},
        //		{TXT_TIBERIUM_SPREAD, 0, 0},
        {TXT_TIBERIUM_FAST, 0, 0},
        {TXT_ROAD_PIECES, 0, 0},
        {TXT_SCATTER, 0, 0},
        {TXT_SHOW_NAMES, 0, 0},
    };

    TextButtonClass ok(200, TXT_OK, TPF_6PT_GRAD | TPF_NOSHADOW, OPTION_X + 5, OPTION_Y + OPTION_HEIGHT - 15);
    TextButtonClass cancel(
        201, TXT_CANCEL, TPF_6PT_GRAD | TPF_NOSHADOW, OPTION_X + OPTION_WIDTH - 50, OPTION_Y + OPTION_HEIGHT - 15);
    buttons = &ok;
    cancel.Add(*buttons);
    int index;
    for (index = 0; index < sizeof(_options) / sizeof(_options[0]); index++) {
        _options[index].Button = new CheckBoxClass(100 + index, OPTION_X + 7, OPTION_Y + 20 + (index * 10));
        if (_options[index].Button) {
            _options[index].Button->Add(*buttons);

            bool value = false;
            switch (_options[index].Description) {
            case TXT_SEPARATE_HELIPAD:
                value = Special.IsSeparate;
                break;

            case TXT_SHOW_NAMES:
                value = Special.IsNamed;
                break;

            case TXT_DEFENDER_ADVANTAGE:
                value = Special.IsDefenderAdvantage;
                break;

            case TXT_VISIBLE_TARGET:
                value = Special.IsVisibleTarget;
                break;

            case TXT_TREE_TARGET:
                value = Special.IsTreeTarget;
                break;

            case TXT_MCV_DEPLOY:
                value = Special.IsMCVDeploy;
                break;

            case TXT_SMART_DEFENCE:
                value = Special.IsSmartDefense;
                break;

            case TXT_THREE_POINT:
                value = Special.IsThreePoint;
                break;

            case TXT_TIBERIUM_GROWTH:
                value = Special.IsTGrowth;
                break;

            case TXT_TIBERIUM_SPREAD:
                value = Special.IsTSpread;
                break;

            case TXT_TIBERIUM_FAST:
                value = Special.IsTFast;
                break;

            case TXT_ROAD_PIECES:
                value = Special.IsRoad;
                break;

            case TXT_SCATTER:
                value = Special.IsScatter;
                break;
            }

            _options[index].Setting = value;
            if (value) {
                _options[index].Button->Turn_On();
            } else {
                _options[index].Button->Turn_Off();
            }
        }
    }

    Map.Override_Mouse_Shape(MOUSE_NORMAL);
    Set_Logic_Page(SeenBuff);
    bool recalc = true;
    bool display = true;
    bool process = true;
    while (process) {

        /*
        ** If we have just received input focus again after running in the background then
        ** we need to redraw.
        */
        if (AllSurfaces.SurfacesRestored) {
            AllSurfaces.SurfacesRestored = false;
            display = true;
        }

        if (GameToPlay == GAME_NORMAL) {
            Call_Back();
        } else {
            if (Main_Loop()) {
                process = false;
            }
        }

        if (display) {
            display = false;

            Hide_Mouse();
            Dialog_Box(OPTION_X, OPTION_Y, OPTION_WIDTH, OPTION_HEIGHT);
            Draw_Caption(TXT_SPECIAL_OPTIONS, OPTION_X, OPTION_Y, OPTION_WIDTH);

            for (index = 0; index < sizeof(_options) / sizeof(_options[0]); index++) {
                Fancy_Text_Print(_options[index].Description,
                                 _options[index].Button->X + 10,
                                 _options[index].Button->Y,
                                 CC_GREEN,
                                 TBLACK,
                                 TPF_6PT_GRAD | TPF_USE_GRAD_PAL | TPF_NOSHADOW);
            }
            buttons->Draw_All();
            Show_Mouse();
        }

        KeyNumType input = buttons->Input();
        switch (input) {
        case KN_ESC:
        case 200 | KN_BUTTON:
            process = false;
            for (index = 0; index < sizeof(_options) / sizeof(_options[0]); index++) {
                switch (_options[index].Description) {
                case TXT_SEPARATE_HELIPAD:
                    oldspecial.IsSeparate = _options[index].Setting;
                    break;

                case TXT_SHOW_NAMES:
                    oldspecial.IsNamed = _options[index].Setting;
                    break;

                case TXT_DEFENDER_ADVANTAGE:
                    oldspecial.IsDefenderAdvantage = _options[index].Setting;
                    break;

                case TXT_VISIBLE_TARGET:
                    oldspecial.IsVisibleTarget = _options[index].Setting;
                    break;

                case TXT_TREE_TARGET:
                    oldspecial.IsTreeTarget = _options[index].Setting;
                    break;

                case TXT_MCV_DEPLOY:
                    oldspecial.IsMCVDeploy = _options[index].Setting;
                    break;

                case TXT_SMART_DEFENCE:
                    oldspecial.IsSmartDefense = _options[index].Setting;
                    break;

                case TXT_THREE_POINT:
                    oldspecial.IsThreePoint = _options[index].Setting;
                    break;

                case TXT_TIBERIUM_GROWTH:
                    oldspecial.IsTGrowth = _options[index].Setting;
                    break;

                case TXT_TIBERIUM_SPREAD:
                    oldspecial.IsTSpread = _options[index].Setting;
                    break;

                case TXT_TIBERIUM_FAST:
                    oldspecial.IsTFast = _options[index].Setting;
                    break;

                case TXT_ROAD_PIECES:
                    oldspecial.IsRoad = _options[index].Setting;
                    break;

                case TXT_SCATTER:
                    oldspecial.IsScatter = _options[index].Setting;
                    break;
                }
            }
            OutList.Add(EventClass(oldspecial));
            break;

        case 201 | KN_BUTTON:
            process = false;
            break;

        case KN_NONE:
            break;

        default:
            index = (input & ~KN_BUTTON) - 100;
            if ((unsigned)index < sizeof(_options) / sizeof(_options[0])) {
                _options[index].Setting = (_options[index].Setting == false);
                if (_options[index].Setting) {
                    _options[index].Button->Turn_On();
                } else {
                    _options[index].Button->Turn_Off();
                }
            }
            break;
        }
    }

    Map.Revert_Mouse_Shape();
    HiddenPage.Clear();
    Map.Flag_To_Redraw(true);
    Map.Render();
}

int Fetch_Difficulty(void)
{
    static const char TXT_EASY[] = "Easy";
    static const char TXT_NORMAL[] = "Normal";
    static const char TXT_HARD[] = "Hard";
    static const char TXT_DIFFICULTY[] = "Difficulty";

    int factor = (SeenBuff.Get_Width() == 320) ? 1 : 2;
    int const w = 250 * factor;
    int const h = 70 * factor;
    int const x = (SeenBuff.Get_Width() / 2) - w / 2;
    int const y = (SeenBuff.Get_Height() / 2) - h / 2;
    int const bwidth = 30 * factor;

    /*
    **	Fill the description buffer with the description text. Break
    **	the text into appropriate spacing.
    */
    char buffer[512];
    strncpy(buffer, TXT_DIFFICULTY, sizeof(buffer) - 1);
    buffer[sizeof(buffer) - 1] = '\0';

    Fancy_Text_Print(TXT_NONE, 0, 0, CC_GREEN, TBLACK, TPF_CENTER | TPF_6PT_GRAD | TPF_USE_GRAD_PAL | TPF_NOSHADOW);
    int width;
    int height;
    Format_Window_String(buffer, w - 60 * factor, width, height);

    /*
    **	Create the OK button.
    */
    TextButtonClass okbutton(1, TXT_OK, TPF_BUTTON, (x + w) - (bwidth + 20 * factor), (y + h) - (18 * factor), bwidth);
    TextButtonClass cancelbutton(3, TXT_CANCEL, TPF_BUTTON, x + (20 * factor), (y + h) - (18 * factor), bwidth);
    GadgetClass* buttonlist = &okbutton;
    cancelbutton.Add(*buttonlist);

    /*
    **	Create the slider button.
    */
    SliderClass slider(2, x + 20 * factor, y + h - 38 * factor, w - 40 * factor, 8 * factor, true);
    if (Rule.IsFineDifficulty) {
        slider.Set_Maximum(5);
        slider.Set_Value(2);
    } else {
        slider.Set_Maximum(3);
        slider.Set_Value(1);
    }
    slider.Add(*buttonlist);

    // Align OK and Cancel button hitboxes with the 4K Ultra Menu CRT terminal layout
    int sw_px = SeenBuff.Get_Width() > 0 ? SeenBuff.Get_Width() : 640;
    int sh_px = SeenBuff.Get_Height() > 0 ? SeenBuff.Get_Height() : 400;
    struct DiffBtnRect
    {
        float u, v, w, h;
        const char* label;
    };
    static const DiffBtnRect kDiffRects[5] = {
        {0.3208f, 0.1080f, 0.3514f, 0.0488f, "DIFFICULTY: EASY"},
        {0.3208f, 0.1842f, 0.3514f, 0.0488f, "DIFFICULTY: NORMAL"},
        {0.3208f, 0.2604f, 0.3514f, 0.0488f, "DIFFICULTY: HARD"},
        {0.3208f, 0.3566f, 0.3514f, 0.0488f, "CONFIRM MISSION"},
        {0.4048f, 0.4368f, 0.1777f, 0.0488f, "CANCEL"},
    };
    okbutton.X = static_cast<int>(kDiffRects[3].u * sw_px);
    okbutton.Y = static_cast<int>(kDiffRects[3].v * sh_px);
    okbutton.Width = static_cast<int>(kDiffRects[3].w * sw_px);
    okbutton.Height = static_cast<int>(kDiffRects[3].h * sh_px);

    cancelbutton.X = static_cast<int>(kDiffRects[4].u * sw_px);
    cancelbutton.Y = static_cast<int>(kDiffRects[4].v * sh_px);
    cancelbutton.Width = static_cast<int>(kDiffRects[4].w * sw_px);
    cancelbutton.Height = static_cast<int>(kDiffRects[4].h * sh_px);

    bool prev_mouse_down = (Get_Mouse_State() == 0) && ((Keyboard->Down(KN_LMOUSE)) != 0);

    /*
    **	Main Processing Loop.
    */
    Set_Logic_Page(SeenBuff);
    bool redraw = true;
    bool process = true;
    while (process) {

        if (redraw) {
            redraw = false;

            /*
            **	Draw the background of the dialog.
            */
            Hide_Mouse();
            Dialog_Box(x, y, w, h);
            Draw_Caption(TXT_NONE, x, y, w);

            /*
            **	Draw the body of the message.
            */
            Fancy_Text_Print(buffer,
                             w / 2 + x,
                             5 * factor + y,
                             CC_GREEN,
                             TBLACK,
                             TPF_CENTER | TPF_6PT_GRAD | TPF_USE_GRAD_PAL | TPF_NOSHADOW);

            /*
            **	Display the descripton of the slider range.
            */
            Fancy_Text_Print(TXT_HARD,
                             slider.X + slider.Width,
                             slider.Y - 9 * factor,
                             CC_GREEN,
                             TBLACK,
                             TPF_RIGHT | TPF_6PT_GRAD | TPF_USE_GRAD_PAL | TPF_DROPSHADOW);
            Fancy_Text_Print(TXT_EASY,
                             slider.X,
                             slider.Y - 9 * factor,
                             CC_GREEN,
                             TBLACK,
                             TPF_6PT_GRAD | TPF_USE_GRAD_PAL | TPF_DROPSHADOW);
            Fancy_Text_Print(TXT_NORMAL,
                             slider.X + (slider.Width / 2),
                             slider.Y - 9 * factor,
                             CC_GREEN,
                             TBLACK,
                             TPF_CENTER | TPF_6PT_GRAD | TPF_USE_GRAD_PAL | TPF_DROPSHADOW);

            /*
            **	Redraw the buttons.
            */
            if (buttonlist) {
                buttonlist->Draw_All();
            }
            Show_Mouse();
        }

        /*
        **	Invoke game callback.
        */
        Call_Back();

        /*
        ** Handle possible surface loss due to a focus switch
        */
        if (AllSurfaces.SurfacesRestored) {
            AllSurfaces.SurfacesRestored = false;
            redraw = true;
            continue;
        }

        /*
        **	Fetch and process input.
        */
        int mx = Get_Mouse_X();
        int my = Get_Mouse_Y();
        bool mouse_down = (Keyboard->Down(KN_LMOUSE) != 0);
        if (mouse_down && !prev_mouse_down) {
            for (int di = 0; di < 3; ++di) {
                int bx = static_cast<int>(kDiffRects[di].u * sw_px);
                int by = static_cast<int>(kDiffRects[di].v * sh_px);
                int bw = static_cast<int>(kDiffRects[di].w * sw_px);
                int bh = static_cast<int>(kDiffRects[di].h * sh_px);
                if (mx >= bx && mx < bx + bw && my >= by && my < by + bh) {
                    slider.Set_Value(Rule.IsFineDifficulty ? (di * 2) : di);
                    Sound_Effect(VOC_BLEEP);
                }
            }
        }
        prev_mouse_down = mouse_down;

        KeyNumType input = buttonlist->Input();

        switch (input) {
        case KN_UP:
        case KN_LEFT:
            if (slider.Get_Value() > 0) {
                slider.Set_Value(slider.Get_Value() - (Rule.IsFineDifficulty ? 2 : 1));
                Sound_Effect(VOC_BLEEP);
            }
            break;

        case KN_DOWN:
        case KN_RIGHT: {
            int max_v = Rule.IsFineDifficulty ? 4 : 2;
            if (slider.Get_Value() < max_v) {
                slider.Set_Value(slider.Get_Value() + (Rule.IsFineDifficulty ? 2 : 1));
                Sound_Effect(VOC_BLEEP);
            }
            break;
        }

        case KN_RETURN:
        case (1 | BUTTON_FLAG):
            process = false;
            break;

        case KN_ESC:
        case (3 | BUTTON_FLAG):
            Video_Set_Ultra_Menu_State(true, nullptr, 0, VersionText, 1);
            return -1;

        default:
            break;
        }

        // Update 4K Ultra Menu CRT buttons for Difficulty Selection
        {
            int cur_diff = Rule.IsFineDifficulty ? (slider.Get_Value() / 2) : slider.Get_Value();
            cur_diff = std::max(0, std::min(cur_diff, 2));
            UltraMenuButtonInfo ubtns[5]{};
            for (int i = 0; i < 5; ++i) {
                int bx = static_cast<int>(kDiffRects[i].u * sw_px);
                int by = static_cast<int>(kDiffRects[i].v * sh_px);
                int bw = static_cast<int>(kDiffRects[i].w * sw_px);
                int bh = static_cast<int>(kDiffRects[i].h * sh_px);
                bool over = (mx >= bx && mx < bx + bw && my >= by && my < by + bh);
                bool sel = (i < 3) ? (cur_diff == i) : (i == 3);
                ubtns[i].x = kDiffRects[i].u;
                ubtns[i].y = kDiffRects[i].v;
                ubtns[i].w = kDiffRects[i].w;
                ubtns[i].h = kDiffRects[i].h;
                ubtns[i].label = kDiffRects[i].label;
                ubtns[i].hover = over ? 1.0f : (sel ? 0.72f : 0.0f);
                ubtns[i].selected = sel;
                ubtns[i].pressed = over && mouse_down;
            }
            Video_Set_Ultra_Menu_State(true, ubtns, 5, VersionText, 1);
        }

        Frame_Limiter(FrameLimitFlags::FL_FORCE_RENDER);
    }

    return (slider.Get_Value() * (Rule.IsFineDifficulty ? 1 : 2));
}
