import React from "react";
import { ROW_LETTERS } from "../utils/sensorLayout";

const COLS = [1, 2, 3, 4, 5, 6] as const;

interface SlotPickerProps {
  value: string;
  onChange: (slot: string) => void;
}

export default function SlotPicker({ value, onChange }: SlotPickerProps) {
  return (
    <div className="slot-picker">
      <div className="slot-picker-corner" />
      {COLS.map((c) => (
        <div key={c} className="slot-picker-hdr">{c}</div>
      ))}
      {ROW_LETTERS.map((row) => (
        <React.Fragment key={row}>
          <div className="slot-picker-hdr">{row}</div>
          {COLS.map((c) => {
            const id = `${c}${row}`;
            return (
              <button
                key={id}
                type="button"
                className={`slot-picker-cell${id === value ? " slot-picker-cell--active" : ""}`}
                onClick={() => onChange(id)}
              >
                {id}
              </button>
            );
          })}
        </React.Fragment>
      ))}
    </div>
  );
}
