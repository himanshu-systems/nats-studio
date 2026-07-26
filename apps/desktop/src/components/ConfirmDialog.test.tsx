import { render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfirmProvider, useConfirm } from "./ConfirmDialog";

function Host({ onResult }: { onResult: (ok: boolean) => void }): JSX.Element {
  const confirm = useConfirm();
  return (
    <button
      onClick={() => {
        void confirm({
          title: 'Delete stream "orders"?',
          description: "This cannot be undone.",
          consequences: ["All messages will be lost."],
          confirmLabel: "Delete stream",
          confirmIcon: "trash",
        }).then(onResult);
      }}
    >
      Trigger
    </button>
  );
}

function renderHost(): { onResult: ReturnType<typeof vi.fn> } {
  const onResult = vi.fn();
  render(
    <ConfirmProvider>
      <Host onResult={onResult} />
    </ConfirmProvider>,
  );
  return { onResult };
}

describe("ConfirmDialog", () => {
  it("shows nothing until confirm() is called", () => {
    renderHost();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("renders the title, description, and consequences once triggered", async () => {
    renderHost();
    await userEvent.click(screen.getByText("Trigger"));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText('Delete stream "orders"?')).toBeInTheDocument();
    expect(screen.getByText("This cannot be undone.")).toBeInTheDocument();
    expect(screen.getByText("All messages will be lost.")).toBeInTheDocument();
  });

  it("resolves true and closes when the confirm button is clicked", async () => {
    const { onResult } = renderHost();
    await userEvent.click(screen.getByText("Trigger"));
    await userEvent.click(screen.getByRole("button", { name: "Delete stream" }));
    expect(onResult).toHaveBeenCalledWith(true);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("resolves false and closes when Cancel is clicked", async () => {
    const { onResult } = renderHost();
    await userEvent.click(screen.getByText("Trigger"));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onResult).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("resolves false on Escape", async () => {
    const { onResult } = renderHost();
    await userEvent.click(screen.getByText("Trigger"));
    await userEvent.keyboard("{Escape}");
    expect(onResult).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("resolves false when the backdrop (outside the dialog) is clicked", async () => {
    const { onResult } = renderHost();
    await userEvent.click(screen.getByText("Trigger"));
    const backdrop = screen.getByRole("alertdialog").parentElement;
    expect(backdrop).not.toBeNull();
    await userEvent.click(backdrop!);
    expect(onResult).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("does not close when clicking inside the dialog body", async () => {
    renderHost();
    await userEvent.click(screen.getByText("Trigger"));
    await userEvent.click(screen.getByText('Delete stream "orders"?'));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("throws when useConfirm is called outside a ConfirmProvider", () => {
    // React logs the render-phase throw to console.error even though the test
    // catches it below — silence that expected noise.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => renderHook(() => useConfirm())).toThrow(/must be used within a ConfirmProvider/);
    } finally {
      spy.mockRestore();
    }
  });
});
