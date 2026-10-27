import { useCallback } from "react";

interface FileUploadProps {
  onFileLoaded: (text: string, fileName: string) => void;
  fileName: string | null;
}

export default function FileUpload({ onFileLoaded, fileName }: FileUploadProps) {
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file) readFile(file);
    },
    [onFileLoaded]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) readFile(file);
    },
    [onFileLoaded]
  );

  function readFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      onFileLoaded(reader.result as string, file.name);
    };
    reader.readAsText(file);
  }

  return (
    <div
      className="file-upload"
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
    >
      <input
        type="file"
        accept=".csv,.tsv,.txt"
        onChange={handleChange}
        id="csv-input"
        className="file-input"
      />
      <label htmlFor="csv-input" className="file-label">
        {fileName ? (
          <span className="file-loaded">
            <span className="file-icon">📁</span> {fileName}
            <span className="file-change">Click to change</span>
          </span>
        ) : (
          <span className="file-prompt">
            <span className="upload-icon">⬆</span>
            <span>Drop CSV file here or click to upload</span>
          </span>
        )}
      </label>
    </div>
  );
}
