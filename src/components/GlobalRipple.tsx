'use client';

import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';

interface Ripple {
  id: number;
  x: number;
  y: number;
  color: string;
}

const colors = ['#FF1E42', '#E50914', '#FF6076', '#B00611', '#FF3B52', '#FF8A9B'];

export function GlobalRipple() {
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const idRef = useRef(0);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const color = colors[Math.floor(Math.random() * colors.length)];
      const newRipple: Ripple = {
        id: idRef.current++,
        x: e.clientX,
        y: e.clientY,
        color,
      };
      
      setRipples(prev => [...prev, newRipple]);
      
      setTimeout(() => {
        setRipples(prev => prev.filter(r => r.id !== newRipple.id));
      }, 800);
    };

    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        pointerEvents: 'none',
        zIndex: 9999,
      }}
      aria-hidden="true"
    >
      {ripples.map(ripple => (
        <motion.div
          key={ripple.id}
          style={{
            position: 'absolute',
            left: ripple.x,
            top: ripple.y,
            transformOrigin: 'center',
          }}
          initial={{ scale: 0, opacity: 1 }}
          animate={{ scale: 3, opacity: 0 }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
        >
          <div
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: ripple.color,
              boxShadow: `0 0 10px ${ripple.color}, 0 0 20px ${ripple.color}, 0 0 40px ${ripple.color}`,
            }}
          />
          <motion.div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: '0',
              height: '0',
              borderRadius: '50%',
              border: `2px solid ${ripple.color}`,
            }}
            initial={{ width: 0, height: 0, opacity: 0.8 }}
            animate={{ width: '60px', height: '60px', opacity: 0 }}
            transition={{ duration: 0.5, ease: 'easeOut', delay: 0.1 }}
          />
          <motion.div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: '0',
              height: '0',
              borderRadius: '50%',
              border: `1px solid ${ripple.color}`,
            }}
            initial={{ width: 0, height: 0, opacity: 0.6 }}
            animate={{ width: '100px', height: '100px', opacity: 0 }}
            transition={{ duration: 0.7, ease: 'easeOut', delay: 0.2 }}
          />
        </motion.div>
      ))}
    </div>
  );
}