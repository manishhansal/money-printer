import React, { useState, useEffect } from 'react';

/** IST minutes since midnight from a Date. */
function istMinutes(d: Date): number {
  return (d.getUTCHours() * 60 + d.getUTCMinutes() + 330) % 1440;
}

function countdownTo(targetH: number, targetM: number): string {
  const now = new Date();
  const istMin = istMinutes(now);
  const targetMin = targetH * 60 + targetM;
  let diff = targetMin - istMin;
  if (diff < 0) diff += 1440; // next day
  const h = Math.floor(diff / 60);
  const m = diff % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

interface TimerRowProps {
  label: string;
  targetH: number;
  targetM: number;
  warnM: number; // minutes threshold to show warning colour
  critM: number; // minutes threshold to show critical colour
}

function TimerRow({ label, targetH, targetM, warnM, critM }: TimerRowProps): React.ReactElement {
  const [countdown, setCountdown] = useState(countdownTo(targetH, targetM));

  useEffect(() => {
    const id = setInterval(() => setCountdown(countdownTo(targetH, targetM)), 30_000);
    return () => clearInterval(id);
  }, [targetH, targetM]);

  const now = new Date();
  const istMin = istMinutes(now);
  const diff = (targetH * 60 + targetM - istMin + 1440) % 1440;

  const color = diff <= critM ? '#ef4444' : diff <= warnM ? '#f59e0b' : '#4b6080';
  const isPast = diff > 1200; // > 20 hours = already passed today

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '4px 0',
        borderBottom: '1px solid #1a2235',
        fontFamily: 'monospace',
        fontSize: 11,
      }}
    >
      <span style={{ color: '#dde4f0' }}>{label}</span>
      <span
        style={{
          color: isPast ? '#22c55e' : color,
          fontWeight: 700,
          letterSpacing: 1,
        }}
      >
        {isPast ? '✓ Done' : countdown}
      </span>
    </div>
  );
}

export function SquareOffTimer(): React.ReactElement {
  return (
    <div>
      <TimerRow label="Entry cutoff (15:00)" targetH={15} targetM={0} warnM={30} critM={5} />
      <TimerRow label="Final cutoff (15:10)" targetH={15} targetM={10} warnM={20} critM={3} />
      <TimerRow label="Square-off (15:15)" targetH={15} targetM={15} warnM={15} critM={2} />
      <TimerRow label="Escalation (15:20)" targetH={15} targetM={20} warnM={10} critM={2} />
      <TimerRow label="Flat verify (15:25)" targetH={15} targetM={25} warnM={8} critM={1} />
      <TimerRow label="Critical alert (15:28)" targetH={15} targetM={28} warnM={5} critM={1} />
    </div>
  );
}
