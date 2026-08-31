import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DataHydrationGate from '@/components/DataHydrationGate';

const mocks = vi.hoisted(() => ({
  listener: null,
  state: {
    phase: 'loading',
    isHydrating: true,
    hydrationComplete: false,
    hydrationError: null,
  },
  hydrate: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}));

vi.mock('@/lib/AuthContext', () => ({ useAuth: () => ({ user: { id: 'user-1' } }) }));
vi.mock('@/lib/dataHydration', () => ({
  getHydrationState: () => mocks.state,
  subscribeHydration: (listener) => {
    mocks.listener = listener;
    listener(mocks.state);
    return () => { mocks.listener = null; };
  },
  hydrateAccountData: mocks.hydrate,
  startAccountSync: mocks.start,
  stopAccountSync: mocks.stop,
  authorizeServerBootstrap: vi.fn(),
  acceptAuthoritativeServerData: vi.fn(),
}));

describe('DataHydrationGate', () => {
  beforeEach(() => {
    mocks.state = {
      phase: 'loading', isHydrating: true, hydrationComplete: false, hydrationError: null,
    };
    mocks.hydrate.mockReset();
    mocks.start.mockReset();
    mocks.stop.mockReset();
  });

  it('does not mount KPI content while account data is unresolved', () => {
    render(<DataHydrationGate><div>Revenue $0</div></DataHydrationGate>);

    expect(screen.getByRole('status')).toHaveTextContent('Verifying account and property scope');
    expect(screen.queryByText('Revenue $0')).not.toBeInTheDocument();
    expect(mocks.hydrate).toHaveBeenCalledWith({ accountId: 'user-1' });
  });

  it('mounts application content only after hydration is ready', () => {
    render(<DataHydrationGate><div>Revenue $12,345.67</div></DataHydrationGate>);

    act(() => {
      mocks.listener({
        phase: 'ready', accountId: 'user-1', isHydrating: false, hydrationComplete: true, hydrationError: null,
      });
    });

    expect(screen.getByText('Revenue $12,345.67')).toBeInTheDocument();
    expect(mocks.start).toHaveBeenCalled();
  });
});
