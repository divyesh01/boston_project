import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, renderHook, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SmartButtonGroup from '@/components/dashboard/SmartButtonGroup';
import OwnerPacketPreview from '@/components/dashboard/OwnerPacketPreview';
import ScheduleReportDialog from '@/components/dashboard/ScheduleReportDialog';
import BatchActionsModal from '@/components/dashboard/BatchActionsModal';
import SidebarNav from '@/components/dashboard/SidebarNav';
import { FEATURE_FLAGS, isFeatureEnabled, setFeatureFlag, useFeatureFlag } from '@/lib/featureFlags';

describe('Luxury UI Feature Flags', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('enables LUXURY_UI_ENABLED by default', () => {
    expect(isFeatureEnabled(FEATURE_FLAGS.LUXURY_UI_ENABLED)).toBe(true);
  });

  it('updates feature flag and allows toggling', () => {
    setFeatureFlag(FEATURE_FLAGS.LUXURY_UI_ENABLED, false);
    expect(isFeatureEnabled(FEATURE_FLAGS.LUXURY_UI_ENABLED)).toBe(false);

    setFeatureFlag(FEATURE_FLAGS.LUXURY_UI_ENABLED, true);
    expect(isFeatureEnabled(FEATURE_FLAGS.LUXURY_UI_ENABLED)).toBe(true);
  });

  it('reactive useFeatureFlag hook updates on setFeatureFlag', () => {
    const { result } = renderHook(() => useFeatureFlag(FEATURE_FLAGS.LUXURY_UI_ENABLED));
    expect(result.current).toBe(true);

    act(() => {
      setFeatureFlag(FEATURE_FLAGS.LUXURY_UI_ENABLED, false);
    });

    expect(result.current).toBe(false);
  });
});

describe('SmartButtonGroup Component', () => {
  it('renders primary and secondary action buttons with click callbacks', () => {
    const onDownloadPacket = vi.fn();
    const onOpenSchedule = vi.fn();
    const onOpenSimulator = vi.fn();
    const onClearCache = vi.fn();

    render(
      <SmartButtonGroup
        onDownloadPacket={onDownloadPacket}
        onOpenSchedule={onOpenSchedule}
        onOpenSimulator={onOpenSimulator}
        onClearCache={onClearCache}
        isExporting={false}
      />
    );

    // Primary action
    const downloadBtn = screen.getByRole('button', { name: /Export Owner Packet/i });
    expect(downloadBtn).toBeInTheDocument();
    fireEvent.click(downloadBtn);
    expect(onDownloadPacket).toHaveBeenCalledTimes(1);

    // Secondary actions
    const simulatorBtn = screen.getByRole('button', { name: /OTA Shift Simulator/i });
    fireEvent.click(simulatorBtn);
    expect(onOpenSimulator).toHaveBeenCalledTimes(1);

    const scheduleBtn = screen.getByRole('button', { name: /Schedule Delivery/i });
    fireEvent.click(scheduleBtn);
    expect(onOpenSchedule).toHaveBeenCalledTimes(1);

    const refreshBtn = screen.getByRole('button', { name: /Refresh Server Data/i });
    fireEvent.click(refreshBtn);
    expect(onClearCache).toHaveBeenCalledTimes(1);
  });

  it('shows generating status and disables primary button while exporting', () => {
    render(
      <SmartButtonGroup
        onDownloadPacket={vi.fn()}
        isExporting={true}
      />
    );

    const downloadBtn = screen.getByRole('button', { name: /Generating Packet.../i });
    expect(downloadBtn).toBeDisabled();
  });
});

describe('OwnerPacketPreview Component', () => {
  it('renders all 5 workbook sheets with details', () => {
    const onDownload = vi.fn();
    render(
      <OwnerPacketPreview
        onDownloadPacket={onDownload}
        revenue={1020598.17}
        roomsSold={12362}
        occupancy={0.578}
        propertiesCount={2}
        isExporting={false}
      />
    );

    expect(screen.getByText('Owner Performance Packet (.xlsx)')).toBeInTheDocument();
    expect(screen.getByText('5-Sheet Multi-Property')).toBeInTheDocument();

    expect(screen.getByText('Executive Summary')).toBeInTheDocument();
    expect(screen.getByText('Property Performance')).toBeInTheDocument();
    expect(screen.getByText('OTA & Channel Economics')).toBeInTheDocument();
    expect(screen.getByText('Data Health & Audit')).toBeInTheDocument();
    expect(screen.getByText('Provenance & Controls')).toBeInTheDocument();

    const downloadBtn = screen.getByRole('button', { name: /Download Packet/i });
    fireEvent.click(downloadBtn);
    expect(onDownload).toHaveBeenCalledTimes(1);
  });
});

describe('ScheduleReportDialog Component', () => {
  it('does not render when isOpen is false', () => {
    const { container } = render(
      <ScheduleReportDialog isOpen={false} onClose={vi.fn()} onSendTest={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders and allows saving delivery schedule when isOpen is true', () => {
    const onClose = vi.fn();
    const onSendTest = vi.fn();

    render(
      <ScheduleReportDialog isOpen={true} onClose={onClose} onSendTest={onSendTest} />
    );

    expect(screen.getByText('Schedule Automated Owner Packets')).toBeInTheDocument();

    // Trigger test delivery
    const sendTestBtn = screen.getByRole('button', { name: /Send Test Now/i });
    fireEvent.click(sendTestBtn);
    expect(onSendTest).toHaveBeenCalledTimes(1);

    // Save configuration
    const saveBtn = screen.getByRole('button', { name: /Save Automation/i });
    fireEvent.click(saveBtn);
    expect(onClose).toHaveBeenCalledTimes(1);

    const savedConfig = JSON.parse(localStorage.getItem('scheduled_report_config') || '{}');
    expect(savedConfig.frequency).toBe('weekly');
    expect(savedConfig.includeProvenance).toBe(true);
  });
});

describe('BatchActionsModal Component', () => {
  it('renders manifest items and triggers batch actions', () => {
    const onApproveAll = vi.fn();
    const onArchiveAll = vi.fn();
    const onClose = vi.fn();
    const selectedItems = [
      { id: 'item-1', report_type: 'Occupancy Summary Jan 2026', row_count: 500 },
      { id: 'item-2', report_type: 'Transactions Ledger Feb 2026', row_count: 1200 },
    ];

    render(
      <BatchActionsModal
        isOpen={true}
        onClose={onClose}
        selectedItems={selectedItems}
        onApproveAll={onApproveAll}
        onArchiveAll={onArchiveAll}
      />
    );

    expect(screen.getByText('Batch Manifest Actions')).toBeInTheDocument();
    expect(screen.getByText('Occupancy Summary Jan 2026')).toBeInTheDocument();
    expect(screen.getByText('500 rows')).toBeInTheDocument();

    // Trigger approve batch action
    const approveBtn = screen.getByRole('button', { name: /Verify & Activate/i });
    fireEvent.click(approveBtn);
    expect(onApproveAll).toHaveBeenCalledWith(selectedItems);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('SidebarNav Component', () => {
  it('renders navigation sections and active scope pill', () => {
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <SidebarNav currentProperty="Boston Hotel & Suites" />
      </MemoryRouter>
    );

    expect(screen.getByText('Boston Hotel & Suites')).toBeInTheDocument();
    expect(screen.getByText('Executive Intelligence')).toBeInTheDocument();
    expect(screen.getByText('Ledgers & Operations')).toBeInTheDocument();
    expect(screen.getByText('Data Governance & Audit')).toBeInTheDocument();

    expect(screen.getByText('Executive Dashboard')).toBeInTheDocument();
    expect(screen.getByText('OTA & Channel Economics')).toBeInTheDocument();
  });
});
