import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FlashBadge, useFlash } from "./message";

function Host({ ms }: { ms?: number }): JSX.Element {
  const [message, show] = useFlash(ms);
  return (
    <div>
      <button onClick={() => show("Downloaded foo.json")}>Trigger</button>
      <FlashBadge message={message} />
    </div>
  );
}

describe("useFlash / FlashBadge", () => {
  it("renders nothing before show() is called", () => {
    render(<Host />);
    expect(screen.queryByText(/Downloaded/)).not.toBeInTheDocument();
  });

  it("shows the message once show() is called", () => {
    render(<Host />);
    act(() => screen.getByText("Trigger").click());
    expect(screen.getByText("Downloaded foo.json")).toBeInTheDocument();
  });

  it("clears itself after the timeout elapses", () => {
    vi.useFakeTimers();
    try {
      render(<Host ms={1000} />);
      act(() => screen.getByText("Trigger").click());
      expect(screen.getByText("Downloaded foo.json")).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1000));
      expect(screen.queryByText("Downloaded foo.json")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts the clear timer on a second trigger instead of stacking", () => {
    vi.useFakeTimers();
    try {
      render(<Host ms={1000} />);
      act(() => screen.getByText("Trigger").click());
      act(() => vi.advanceTimersByTime(700));
      act(() => screen.getByText("Trigger").click()); // resets the window
      act(() => vi.advanceTimersByTime(700));
      // only 700ms of the *new* 1000ms window has elapsed — still visible.
      expect(screen.getByText("Downloaded foo.json")).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(300));
      expect(screen.queryByText("Downloaded foo.json")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
