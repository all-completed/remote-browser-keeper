import { createContext, useContext, useState } from "react";
import { Modal } from "rsuite";

// The full-size screenshot, in the window (issue #28) — it used to be a window of its own,
// sized to the image. An rsuite Modal at full size; the image keeps its natural size and
// the modal scrolls when it is larger than the window. Only data: images are ever shown
// (the CSP allows nothing else, and neither does this).
const ViewerContext = createContext(() => {});

export function useImageViewer() { return useContext(ViewerContext); }

export function ImageViewerProvider({ children }) {
  const [src, setSrc] = useState(null);
  const view = (dataUrl) => { if (typeof dataUrl === "string" && /^data:image\//.test(dataUrl)) setSrc(dataUrl); };
  return (
    <ViewerContext.Provider value={view}>
      {children}
      <Modal open={!!src} onClose={() => setSrc(null)} size="full" className="image-viewer">
        <Modal.Header>
          <Modal.Title>Screenshot</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {src && <img src={src} alt="Proof screenshot" className="image-viewer-img" />}
        </Modal.Body>
      </Modal>
    </ViewerContext.Provider>
  );
}
