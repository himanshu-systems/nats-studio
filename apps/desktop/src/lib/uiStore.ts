import { create } from "zustand";

interface UiState {
  /** Active nav item id (see `nav.ts`). */
  view: string;
  setView: (view: string) => void;
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  /**
   * A subject handed to Live Tail by another view — e.g. "watch this push
   * consumer's deliver subject". Live Tail pre-fills its input from this and
   * then clears it, so the same request can be made again later.
   */
  tailSubject: string | null;
  openLiveTail: (subject: string) => void;
  clearTailSubject: () => void;
}

/** Client-only UI state: which feature view is showing, sidebar collapse. */
export const useUiStore = create<UiState>((set) => ({
  view: "overview",
  setView: (view) => set({ view }),
  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  tailSubject: null,
  openLiveTail: (subject) => set({ view: "livetail", tailSubject: subject }),
  clearTailSubject: () => set({ tailSubject: null }),
}));
