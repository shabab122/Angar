import { useEffect, useState, useRef } from "react";
export function PwaControls() {
  const applying = useRef(false);
  const [install, setInstall] = useState(null),
    [waiting, setWaiting] = useState(null),
    [installed, setInstalled] = useState(false),
    [help, setHelp] = useState(false);
  useEffect(() => {
    const prompt = (event) => {
        event.preventDefault();
        setInstall(event);
      },
      done = () => {
        setInstall(null);
        setInstalled(true);
      };
    window.addEventListener("beforeinstallprompt", prompt);
    window.addEventListener("appinstalled", done);
    let active = true,
      registration,
      change;
    const attach = (reg) => {
      registration = reg;
      if (reg.waiting && active) setWaiting(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const worker = reg.installing;
        worker?.addEventListener("statechange", () => {
          if (
            active &&
            worker.state === "installed" &&
            navigator.serviceWorker.controller
          )
            setWaiting(worker);
        });
      });
    };
    if ("serviceWorker" in navigator && import.meta.env.PROD) {
      void navigator.serviceWorker
        .register("/sw.js")
        .then(attach)
        .catch(() => {});
      change = () => {
        if (applying.current) window.location.reload();
        else window.dispatchEvent(new Event("angar:catalog-ready"));
      };
      navigator.serviceWorker.addEventListener("controllerchange", change);
    }
    return () => {
      active = false;
      window.removeEventListener("beforeinstallprompt", prompt);
      window.removeEventListener("appinstalled", done);
      if (change)
        navigator.serviceWorker.removeEventListener("controllerchange", change);
    };
  }, []);
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    navigator.standalone;
  return (
    <div className="pwa-controls">
      {install && !standalone && (
        <button
          type="button"
          onClick={async () => {
            await install.prompt();
            const choice = await install.userChoice;
            if (choice.outcome === "accepted") setInstall(null);
          }}
        >
          Install Angar app
        </button>
      )}
      {!install && !standalone && !installed && (
        <button type="button" onClick={() => setHelp(!help)}>
          Install app
        </button>
      )}
      {help && (
        <p role="status">
          Use your browser menu → Install app or Add to Home Screen. The app
          needs HTTPS or localhost.
        </p>
      )}
      {waiting && (
        <div role="status">
          <span>
            An app update is ready. Finish any payment, then apply it.
          </span>
          <button
            type="button"
            onClick={() => {
              applying.current = true;
              waiting.postMessage({ type: "ACTIVATE_UPDATE" });
            }}
          >
            Apply update & reload
          </button>
        </div>
      )}
    </div>
  );
}
