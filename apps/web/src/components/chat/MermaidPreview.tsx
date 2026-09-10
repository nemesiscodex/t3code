import { useEffect, useState } from "react";
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "../ui/dialog";
import { ZoomableImage } from "./ZoomableImage";

/** Mounted only on request; streaming updates do not change the requested diagram. */
export function MermaidPreview({
  code,
  theme,
  onClose,
}: {
  code: string;
  theme: "light" | "dark";
  onClose: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    async function render() {
      try {
        const { renderMermaidSVG, THEMES } = await import("beautiful-mermaid");
        if (cancelled) return;
        const svg = renderMermaidSVG(code, THEMES[theme === "dark" ? "zinc-dark" : "zinc-light"]);
        objectUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
        setSrc(objectUrl);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Could not render this diagram.");
        }
      }
    }
    void render();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [code, theme]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="w-auto max-w-[96vw] p-4" bottomStickOnMobile={false}>
        <DialogTitle className="pr-8 text-base">Mermaid diagram</DialogTitle>
        <DialogDescription className="my-2">
          Scroll to zoom, drag to pan. Use +, − or 0 to zoom or fit, and arrow keys to move.
        </DialogDescription>
        {error ? (
          <pre
            role="alert"
            className="max-h-[60vh] max-w-[80vw] overflow-auto whitespace-pre-wrap text-sm"
          >
            {error}
          </pre>
        ) : src ? (
          <ZoomableImage
            src={src}
            name="Mermaid diagram"
            controls
            onError={() => setError("Could not display this diagram.")}
          />
        ) : (
          <p role="status" className="p-8 text-sm text-muted-foreground">
            Rendering diagram…
          </p>
        )}
      </DialogPopup>
    </Dialog>
  );
}
