import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import PropertyRanking from '@/components/dashboard/PropertyRanking';

describe('PropertyRanking & Variance Decomposition UI', () => {
  const properties = [
    { id: 1, name: 'Boston Inn', rooms: 100 },
    { id: 2, name: 'Hartford Suites', rooms: 80 },
  ];

  const occRows = [
    { property_id: 1, date: '2026-01-01', rooms_sold: 80, room_revenue: 8000 },
    { property_id: 2, date: '2026-01-01', rooms_sold: 40, room_revenue: 3600 },
  ];

  const compareOccRows = [
    { property_id: 1, date: '2025-01-01', rooms_sold: 75, room_revenue: 7500 },
    { property_id: 2, date: '2025-01-01', rooms_sold: 50, room_revenue: 4500 },
  ];

  it('renders properties and weighted portfolio totals accurately', () => {
    render(
      <PropertyRanking
        properties={properties}
        occRows={occRows}
        compareOccRows={compareOccRows}
      />
    );

    // Verify property rows
    expect(screen.getAllByText('Boston Inn')[0]).toBeInTheDocument();
    expect(screen.getAllByText('Hartford Suites')[0]).toBeInTheDocument();

    // Verify Portfolio Total row
    const totalRow = screen.getByRole('row', { name: /Portfolio Total/ });
    expect(totalRow).toBeInTheDocument();
    // Total rooms sold: 80 + 40 = 120
    // Total capacity: 100 + 80 = 180
    // Occ: 120 / 180 = 66.7%
    expect(totalRow).toHaveTextContent('66.7%');
    // Total revenue: $8,000 + $3,600 = $11,600
    expect(totalRow).toHaveTextContent('$11,600');
  });

  it('displays interactive variance decomposition diagnosis when clicking a property', () => {
    render(
      <PropertyRanking
        properties={properties}
        occRows={occRows}
        compareOccRows={compareOccRows}
      />
    );

    // Click Hartford Suites table row to inspect variance
    const hartfordRow = screen.getAllByText('Hartford Suites')[0];
    fireEvent.click(hartfordRow);

    // Diagnosis card should appear
    expect(screen.getByText(/Variance Diagnosis: Hartford Suites/)).toBeInTheDocument();
    expect(screen.getByText(/Room Volume Effect/)).toBeInTheDocument();
    expect(screen.getByText(/Rate \/ ADR Pricing Effect/)).toBeInTheDocument();
  });
});
