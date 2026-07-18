import { create } from "zustand";

interface UiState {
  /** Active nav item id (see `nav.ts`). */
  view: string;
  setView: (view: string) => void;
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
}

/** Client-only UI state: which feature view is showing, sidebar collapse. */
export const useUiStore = create<UiState>((set) => ({
  view: "overview",
  setView: (view) => set({ view }),
  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
}));
