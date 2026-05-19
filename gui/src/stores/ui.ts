import { create } from "zustand";

import type { AppError } from "@/types/app-error";

export type Screen = "onboarding" | "empty" | "main";

interface UiState {
  screen: Screen;
  paletteOpen: boolean;
  settingsOpen: boolean;

  toasts: AppError[];

  /**
   * Desktop Pet implicit-migration staging slot. Set by the title-menu
   * click in a session that doesn't currently hold the pet; consumed
   * by the pet_detached IPC handler to fire the follow-up attach_pet
   * once the old pet's port is released.
   *
   * Pure UI coordination state, no persistence — pet's subprocess dies
   * on app exit anyway.
   */
  pendingPetMigrationTo: string | null;
}

interface UiActions {
  setScreen: (s: Screen) => void;
  setPaletteOpen: (o: boolean) => void;
  togglePalette: () => void;
  setSettingsOpen: (o: boolean) => void;
  toggleSettings: () => void;

  pushToast: (e: AppError) => void;
  dismissToast: (id: string) => void;

  setPendingPetMigration: (sessionId: string | null) => void;
}

export type UiStore = UiState & UiActions;

export const useUiStore = create<UiStore>((set, get) => ({
  screen: "empty",
  paletteOpen: false,
  settingsOpen: false,
  toasts: [],
  pendingPetMigrationTo: null,

  setScreen: (s) => set({ screen: s }),
  setPaletteOpen: (o) => set({ paletteOpen: o }),
  togglePalette: () => set({ paletteOpen: !get().paletteOpen }),
  setSettingsOpen: (o) => set({ settingsOpen: o }),
  toggleSettings: () => set({ settingsOpen: !get().settingsOpen }),

  pushToast: (e) =>
    set((state) => ({
      toasts: [e, ...state.toasts.filter((t) => t.id !== e.id)],
    })),

  dismissToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    })),

  setPendingPetMigration: (sessionId) =>
    set({ pendingPetMigrationTo: sessionId }),
}));
