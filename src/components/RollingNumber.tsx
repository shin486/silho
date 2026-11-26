"use client";

import { AnimatePresence, motion } from "motion/react";

const EASE = [0.22, 1, 0.36, 1] as const;

function RollingDigit({ char }: { char: string }) {
  return (
    <span
      aria-hidden="true"
      className="relative inline-flex h-[1.3em] items-center overflow-hidden"
    >
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={char}
          className="inline-block"
          initial={{ y: "100%", opacity: 0 }}
          animate={{ y: "0%", opacity: 1 }}
          exit={{ y: "-100%", opacity: 0 }}
          transition={{ duration: 0.26, ease: EASE }}
        >
          {char}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

interface RollingNumberProps {
  value: number;
  className?: string;
}

/**
 * Mechanical odometer-style counter: only the digits that change roll
 * vertically. Screen readers get the plain number.
 */
export function RollingNumber({ value, className = "" }: RollingNumberProps) {
  const chars = String(Math.max(0, Math.trunc(value))).split("");

  return (
    <span className={`inline-flex items-center tabular-nums ${className}`}>
      <span className="sr-only">{value}</span>
      {chars.map((char, index) => (
        <RollingDigit key={chars.length - index} char={char} />
      ))}
    </span>
  );
}
