import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { SplitPane } from "./SplitPane";

function renderSplit(props: Partial<React.ComponentProps<typeof SplitPane>> = {}) {
  return render(
    <SplitPane id="test" {...props}>
      <div>first pane</div>
      <div>second pane</div>
    </SplitPane>,
  );
}

/** The grid template carries the split — assert on it rather than pixel sizes,
 *  since jsdom gives every element a zero-size bounding box. */
const template = (el: HTMLElement): string =>
  el.style.gridTemplateColumns || el.style.gridTemplateRows;

const separator = (): HTMLElement => screen.getByRole("separator");
const grid = (): HTMLElement => separator().parentElement as HTMLElement;

describe("SplitPane", () => {
  beforeEach(() => localStorage.clear());

  it("renders both panes and an accessible separator", () => {
    renderSplit();
    expect(screen.getByText("first pane")).toBeInTheDocument();
    expect(screen.getByText("second pane")).toBeInTheDocument();
    expect(separator()).toHaveAttribute("aria-orientation", "vertical");
  });

  it("starts at the requested split", () => {
    renderSplit({ initial: 30 });
    expect(template(grid())).toBe("30fr 1px 70fr");
    expect(separator()).toHaveAttribute("aria-valuenow", "30");
  });

  it("splits rows when vertical", () => {
    renderSplit({ orientation: "vertical", initial: 40 });
    expect(grid().style.gridTemplateRows).toBe("40fr 1px 60fr");
    expect(separator()).toHaveAttribute("aria-orientation", "horizontal");
  });

  it("nudges with the arrow keys", async () => {
    renderSplit({ initial: 50 });
    separator().focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(separator()).toHaveAttribute("aria-valuenow", "52");
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(separator()).toHaveAttribute("aria-valuenow", "48");
  });

  it("takes a bigger step with shift held", async () => {
    renderSplit({ initial: 50 });
    separator().focus();
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(separator()).toHaveAttribute("aria-valuenow", "60");
  });

  it("clamps to min and max, including via Home/End", async () => {
    renderSplit({ initial: 50, min: 20, max: 80 });
    separator().focus();
    await userEvent.keyboard("{Home}");
    expect(separator()).toHaveAttribute("aria-valuenow", "20");
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(separator()).toHaveAttribute("aria-valuenow", "20"); // cannot go below min
    await userEvent.keyboard("{End}");
    expect(separator()).toHaveAttribute("aria-valuenow", "80");
    await userEvent.keyboard("{ArrowRight}");
    expect(separator()).toHaveAttribute("aria-valuenow", "80"); // nor above max
  });

  it("follows the pointer while dragging, and stops once released", () => {
    renderSplit({ initial: 50 });
    const sep = separator();
    // jsdom reports a zero-size box, so pin one down for the drag maths.
    grid().getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1000, height: 500 }) as DOMRect;

    fireEvent.pointerDown(sep, { pointerId: 1 });
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 300 });
    expect(sep).toHaveAttribute("aria-valuenow", "30");

    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 700 });
    expect(sep).toHaveAttribute("aria-valuenow", "70");

    fireEvent.pointerUp(sep, { pointerId: 1 });
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 100 });
    expect(sep).toHaveAttribute("aria-valuenow", "70"); // no longer dragging
  });

  it("clamps a drag that runs past the bounds", () => {
    renderSplit({ initial: 50, min: 25, max: 75 });
    const sep = separator();
    grid().getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1000, height: 500 }) as DOMRect;

    fireEvent.pointerDown(sep, { pointerId: 1 });
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: -200 });
    expect(sep).toHaveAttribute("aria-valuenow", "25");
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 5000 });
    expect(sep).toHaveAttribute("aria-valuenow", "75");
  });

  it("resets to the initial split on double-click", async () => {
    renderSplit({ initial: 50 });
    separator().focus();
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(separator()).toHaveAttribute("aria-valuenow", "60");
    await userEvent.dblClick(separator());
    expect(separator()).toHaveAttribute("aria-valuenow", "50");
  });

  it("remembers the split per id", async () => {
    const { unmount } = renderSplit({ initial: 50 });
    separator().focus();
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(separator()).toHaveAttribute("aria-valuenow", "60");
    unmount();

    renderSplit({ initial: 50 }); // same id — picks the stored value back up
    expect(separator()).toHaveAttribute("aria-valuenow", "60");
  });

  it("keeps different ids independent", async () => {
    const { unmount } = renderSplit({ initial: 50 });
    separator().focus();
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    unmount();

    renderSplit({ id: "other", initial: 25 });
    expect(separator()).toHaveAttribute("aria-valuenow", "25");
  });

  it("ignores a corrupt stored value instead of breaking the layout", () => {
    localStorage.setItem("ns.split.test", "not-a-number");
    renderSplit({ initial: 35 });
    expect(separator()).toHaveAttribute("aria-valuenow", "35");
  });

  it("re-clamps a stored value that no longer fits the bounds", () => {
    localStorage.setItem("ns.split.test", "95");
    renderSplit({ initial: 50, min: 20, max: 80 });
    expect(separator()).toHaveAttribute("aria-valuenow", "80");
  });

  it("stacks without a separator below the breakpoint", () => {
    // jsdom's window is 1024px wide, so a 1400px breakpoint is the narrow case.
    renderSplit({ stackBelow: 1400 });
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    expect(screen.getByText("first pane")).toBeInTheDocument();
    expect(screen.getByText("second pane")).toBeInTheDocument();
  });

  it("splits once the viewport clears the breakpoint", () => {
    renderSplit({ stackBelow: 800 }); // 1024 >= 800
    expect(screen.getByRole("separator")).toBeInTheDocument();
  });
});
