import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Suscripciones, usuarios premium y cupones — ixi 4k (PREPARADO A FUTURO)
 *
 * El panel admin ya puede gestionar cupones, conceder/quitar premium y ver
 * los planes definidos. La FACTURACIÓN real aún no está activada: el estado
 * se muestra de forma explícita en la interfaz (sin simular cobros).
 */

export interface Coupon {
  id: string;
  code: string;
  /** Descuento en porcentaje (0–100) */
  percentOff: number;
  maxUses: number;
  uses: number;
  /** Caducidad ISO (null = sin caducidad) */
  expiresAt: string | null;
  active: boolean;
  createdAt: string;
}

export interface PremiumUser {
  id: string;
  email: string;
  plan: string;
  since: string;
  active: boolean;
}

export interface PlanInfo {
  id: string;
  name: string;
  price: string;
  /** `disponible` = operativa; `pendiente` = preparada sin facturación */
  status: 'disponible' | 'pendiente';
  features: string[];
}

interface SubscriptionState {
  coupons: Coupon[];
  premiumUsers: PremiumUser[];
  plans: PlanInfo[];
  createCoupon: (input: {
    code: string;
    percentOff: number;
    maxUses: number;
    expiresAt: string | null;
  }) => { ok: boolean; reason?: string };
  toggleCoupon: (id: string) => void;
  deleteCoupon: (id: string) => void;
  grantPremium: (email: string, plan: string) => { ok: boolean; reason?: string };
  revokePremium: (id: string) => void;
  updatePlan: (id: string, patch: Partial<Pick<PlanInfo, 'name' | 'price' | 'status'>>) => void;
}

const defaultPlans: PlanInfo[] = [
  {
    id: 'free',
    name: 'Gratuito',
    price: '0 €',
    status: 'disponible',
    features: ['Exportación 4K local', 'Vista previa y diagnósticos', 'Soporte de reportes'],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '—',
    status: 'pendiente',
    features: [
      'Funciones premium reservadas',
      'Facturación pendiente de activación (futura versión)',
    ],
  },
];

export const useSubscriptionStore = create<SubscriptionState>()(
  persist(
    (set, get) => ({
      coupons: [],
      premiumUsers: [],
      plans: defaultPlans,

      createCoupon: ({ code, percentOff, maxUses, expiresAt }) => {
        const clean = code.trim().toUpperCase();
        if (!clean) return { ok: false, reason: 'El cupón necesita un código' };
        if (percentOff <= 0 || percentOff > 100) {
          return { ok: false, reason: 'El descuento debe estar entre 1 y 100' };
        }
        if (maxUses < 1) return { ok: false, reason: 'Usos mínimos: 1' };
        const exists = get().coupons.some((c) => c.code === clean);
        if (exists) return { ok: false, reason: 'Ya existe un cupón con ese código' };
        const coupon: Coupon = {
          id: `cup_${Date.now()}`,
          code: clean,
          percentOff,
          maxUses,
          uses: 0,
          expiresAt: expiresAt || null,
          active: true,
          createdAt: new Date().toISOString(),
        };
        set((state) => ({ coupons: [coupon, ...state.coupons] }));
        return { ok: true };
      },

      toggleCoupon: (id) => {
        set((state) => ({
          coupons: state.coupons.map((c) =>
            c.id === id ? { ...c, active: !c.active } : c
          ),
        }));
      },

      deleteCoupon: (id) => {
        set((state) => ({ coupons: state.coupons.filter((c) => c.id !== id) }));
      },

      grantPremium: (email, plan) => {
        const clean = email.trim().toLowerCase();
        if (!clean || !clean.includes('@')) {
          return { ok: false, reason: 'Correo no válido' };
        }
        const already = get().premiumUsers.find((p) => p.email === clean);
        if (already) {
          if (already.active) return { ok: false, reason: 'Ese usuario ya es premium' };
          set((state) => ({
            premiumUsers: state.premiumUsers.map((p) =>
              p.id === already.id ? { ...p, active: true, plan, since: new Date().toISOString() } : p
            ),
          }));
          return { ok: true };
        }
        const entry: PremiumUser = {
          id: `prem_${Date.now()}`,
          email: clean,
          plan,
          since: new Date().toISOString(),
          active: true,
        };
        set((state) => ({ premiumUsers: [entry, ...state.premiumUsers] }));
        return { ok: true };
      },

      revokePremium: (id) => {
        set((state) => ({
          premiumUsers: state.premiumUsers.filter((p) => p.id !== id),
        }));
      },

      updatePlan: (id, patch) => {
        set((state) => ({
          plans: state.plans.map((p) => (p.id === id ? { ...p, ...patch } : p)),
        }));
      },
    }),
    {
      name: 'ixi-4k-subs-storage',
      partialize: (state) => ({
        coupons: state.coupons,
        premiumUsers: state.premiumUsers,
        plans: state.plans,
      }),
      version: 1,
    }
  )
);
