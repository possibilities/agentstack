"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Hint } from "./parts";

type Detector = { detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue: string }>> };
type DetectorClass = { new (options: { formats: string[] }): Detector; getSupportedFormats: () => Promise<string[]> };
const detectorClass = () => (window as unknown as { BarcodeDetector?: DetectorClass }).BarcodeDetector;

/** Optional local camera, only on an explicit gesture. QR strings are data, never
 * navigation. No polyfill, online decoder or permission request on mount. */
export function ReceiptCamera({ disabled, onText }: { disabled: boolean; onText: (text: string) => void }) {
  const [available, setAvailable] = useState(false), [active, setActive] = useState(false), [error, setError] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null), stream = useRef<MediaStream | null>(null), timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const starting = useRef(false), generation = useRef(0);
  const stop = () => { generation.current++; if (timer.current) clearInterval(timer.current); timer.current = null; stream.current?.getTracks().forEach(track => track.stop()); stream.current = null; setActive(false); };
  useEffect(() => {
    let disposed = false;
    if (typeof navigator.mediaDevices !== "undefined" && detectorClass()) void detectorClass()!.getSupportedFormats().then(formats => { if (!disposed) setAvailable(formats.includes("qr_code")); }).catch(() => {});
    return () => { disposed = true; generation.current++; if (timer.current) clearInterval(timer.current); stream.current?.getTracks().forEach(track => track.stop()); };
  }, []);
  useEffect(() => { if (disabled) stop(); }, [disabled]); // Stop on expiry, dispatch or unavailable authority.
  const start = async () => {
    if (disabled || active || starting.current || !available) return;
    starting.current = true; setError(null); const current = ++generation.current;
    try {
      const media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      if (generation.current !== current) { media.getTracks().forEach(track => track.stop()); return; }
      stream.current = media; setActive(true);
      // The video stays mounted so it is available before the state update paints.
      video.current!.srcObject = media; await video.current!.play();
      if (generation.current !== current) return;
      const detector = new (detectorClass()!)({ formats: ["qr_code"] });
      let reading = false;
      timer.current = setInterval(async () => {
        if (reading || !video.current || video.current.readyState < 2) return;
        reading = true;
        try {
          const result = await detector.detect(video.current);
          if (generation.current === current && result[0]) { const text = result[0].rawValue; stop(); onText(text); }
        } catch { if (generation.current === current) { stop(); setError("Camera decoding failed. Paste the receipt instead; nothing was accepted or opened."); } }
        finally { reading = false; }
      }, 300);
    } catch { stop(); setError("Camera unavailable or permission declined. Paste the receipt instead; nothing was accepted or opened."); }
    finally { starting.current = false; }
  };
  return <div className="flex flex-col gap-2">
    {available ? <div><Button variant="outline" disabled={disabled} onClick={() => active ? stop() : void start()}>{active ? "Stop camera" : "Scan receipt with camera"}</Button></div>
      : <Hint>Camera QR scanning is unavailable in this browser. Paste works everywhere; no camera permission is requested.</Hint>}
    <video ref={video} hidden={!active} muted playsInline aria-label="Receipt camera preview" className="w-full rounded-lg" />
    {error ? <p role="alert" className="text-sm">{error}</p> : null}
  </div>;
}
