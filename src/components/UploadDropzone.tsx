"use client";

import { useRef, useState, type DragEvent } from "react";

export type UploadState = "empty" | "uploading" | "analyzing" | "mapped" | "warning" | "error";

const stateCopy: Record<UploadState, { title: string; detail: string }> = {
  empty: {
    title: "Upload your product catalog",
    detail: "CSV · XLSX · XLS (demo — no file is actually parsed)",
  },
  uploading: { title: "Uploading…", detail: "Sending your file to StorePilot" },
  analyzing: { title: "Reading spreadsheet…", detail: "Mapping fields and checking your catalog" },
  mapped: { title: "Ready", detail: "Review the suggested field mapping below" },
  warning: { title: "Ready — a few things to check", detail: "Some fields need your attention" },
  error: { title: "Upload failed", detail: "We couldn't read that file — try again" },
};

export function UploadDropzone({
  state,
  onFile,
}: {
  state: UploadState;
  /** Fired with the browser's file-input change event, for its (display-only) filename. */
  onFile: (e: { target: { files: FileList | null } }) => void;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const copy = stateCopy[state];

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragging(false);
    onFile({ target: { files: e.dataTransfer.files } });
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Upload product spreadsheet"
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
      className={`flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed p-10 text-center transition-colors ${
        isDragging
          ? "border-[var(--sp-green-500)] bg-[var(--sp-mint-100)]"
          : state === "error"
          ? "border-[#f2b8b5] bg-[#fdf2f2]"
          : state === "warning"
          ? "border-[#f5cfa0] bg-[#fff8ef]"
          : "border-[var(--sp-border)] sp-gradient-soft sp-upload-glow"
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".csv,.xlsx"
        className="sr-only"
        onChange={onFile}
      />
      <span
        aria-hidden="true"
        className={`mb-3 flex h-12 w-12 items-center justify-center rounded-full text-xl ${
          state === "uploading" || state === "analyzing" ? "animate-pulse" : ""
        } ${
          state === "error"
            ? "bg-[#fde8e8] text-[#b42318]"
            : state === "warning"
            ? "bg-[#fff0e0] text-[#a3510a]"
            : "bg-[var(--sp-mint-200)] text-[var(--sp-emerald-800)]"
        }`}
      >
        {state === "error" ? "✕" : state === "warning" ? "▲" : state === "mapped" ? "✓" : "⇧"}
      </span>
      <p className="font-medium">{copy.title}</p>
      <p className="mt-1 text-sm text-[var(--sp-muted)]">{copy.detail}</p>
      {state === "empty" && (
        <span className="mt-4 rounded-full sp-gradient-primary px-4 py-2 text-sm font-semibold text-white">
          Choose file
        </span>
      )}
    </div>
  );
}
