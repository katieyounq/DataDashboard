import { useMemo, useRef } from "react";
import { getEventColor, resolveEventCaption } from "../utils/csvParser";
import {
  resolveEventVisual,
  type DataConfigRowParsed,
  type ResolvedEventVisual,
} from "../utils/dataConfigCsv";

interface EventLegendProps {
  events: number[];
  eventLabels: Map<number, string>;
  hiddenEvents: Set<number>;
  onToggleEvent: (evt: number) => void;
  onSetHiddenEvents?: (hidden: Set<number>) => void;
  /** Latest sample timestamp per event in the current chart window (for time-aligned DataConfig labels). */
  eventLatestTimestamp?: Map<number, number>;
  dataConfigEntries?: readonly DataConfigRowParsed[];
}

export default function EventLegend({
  events,
  eventLabels,
  hiddenEvents,
  onToggleEvent,
  onSetHiddenEvents,
  eventLatestTimestamp,
  dataConfigEntries = [],
}: EventLegendProps) {
  const cacheRef = useRef<Map<number, ResolvedEventVisual>>(new Map());

  const visuals = useMemo(() => {
    const prev = cacheRef.current;
    const next = new Map<number, ResolvedEventVisual>();

    for (const evt of events) {
      const t = eventLatestTimestamp?.get(evt);
      if (t !== undefined) {
        const v = resolveEventVisual(t, evt, eventLabels, dataConfigEntries);
        next.set(evt, v);
      } else if (prev.has(evt)) {
        next.set(evt, prev.get(evt)!);
      } else {
        const cfgMatch = dataConfigEntries
          .filter((e) => e.eventCounter === evt)
          .sort((a, b) => b.startTimeMs - a.startTimeMs)[0];
        if (cfgMatch) {
          next.set(evt, resolveEventVisual(cfgMatch.startTimeMs, evt, eventLabels, dataConfigEntries));
        } else {
          next.set(evt, {
            caption: `${evt} – ${resolveEventCaption(evt, eventLabels)}`,
            color: getEventColor(evt),
          });
        }
      }
    }

    cacheRef.current = next;
    return next;
  }, [events, eventLabels, eventLatestTimestamp, dataConfigEntries]);

  return (
    <div className="event-legend">
      <div className="event-legend-header">
        <h4>Events</h4>
        {onSetHiddenEvents && (
          <div className="event-legend-actions">
            <button
              type="button"
              className="event-toggle-btn"
              onClick={() => onSetHiddenEvents(new Set())}
            >
              Select All
            </button>
            <button
              type="button"
              className="event-toggle-btn"
              onClick={() => onSetHiddenEvents(new Set(events))}
            >
              Deselect All
            </button>
          </div>
        )}
      </div>
      <div className="legend-items">
        {events.map((evt) => {
          const visible = !hiddenEvents.has(evt);
          const visual = visuals.get(evt)!;
          return (
            <label key={evt} className="legend-item legend-checkbox">
              <input
                type="checkbox"
                checked={visible}
                onChange={() => onToggleEvent(evt)}
              />
              <span
                className="legend-dot"
                style={{ backgroundColor: visual.color }}
              />
              <span className="legend-label">
                {visual.caption}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
