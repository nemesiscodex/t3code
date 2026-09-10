import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { MermaidPreview } from "./MermaidPreview";

const renderMermaidSVG = vi.hoisted(() => vi.fn());
vi.mock("beautiful-mermaid", () => ({
  renderMermaidSVG,
  THEMES: { "zinc-dark": {}, "zinc-light": {} },
}));
vi.mock("../ui/dialog", () => {
  const Wrapper = ({ children }: { children: ReactNode }) => <>{children}</>;
  return {
    Dialog: Wrapper,
    DialogPopup: Wrapper,
    DialogTitle: Wrapper,
    DialogDescription: Wrapper,
  };
});
vi.mock("./ZoomableImage", () => ({ ZoomableImage: () => null }));

let renderer: ReactTestRenderer | undefined;
function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  act(() => {
    renderer = create(<MermaidPreview code="graph TD; A-->B" theme="dark" onClose={() => {}} />);
  });
}

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it("skips rendering when closed before the library finishes loading", async () => {
  const createObjectURL = vi.spyOn(URL, "createObjectURL");
  mount();
  act(() => renderer?.unmount());
  await act(async () => {});
  expect(renderMermaidSVG).not.toHaveBeenCalled();
  expect(createObjectURL).not.toHaveBeenCalled();
});

it("releases the generated image when the preview closes", async () => {
  renderMermaidSVG.mockReturnValueOnce("<svg />");
  const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:diagram");
  const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  await act(async () => mount());
  expect(createObjectURL).toHaveBeenCalledTimes(1);
  await act(async () => renderer?.unmount());
  expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:diagram");
});

it("shows diagram errors", async () => {
  renderMermaidSVG.mockImplementationOnce(() => {
    throw new Error("Invalid diagram syntax");
  });
  await act(async () => mount());
  expect(renderer!.root.findByProps({ role: "alert" }).children).toEqual([
    "Invalid diagram syntax",
  ]);
});
