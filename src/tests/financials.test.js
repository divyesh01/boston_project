import { describe, it, expect } from 'vitest';
import { CalculationService } from '../lib/calculationService';

describe('CalculationService - Financial Metrics', () => {
  it('calculates portfolio ADR using a weighted average by rooms sold', () => {
    // Property 1: Sold 10 rooms at $200 ADR ($2,000 revenue)
    // Property 2: Sold 100 rooms at $50 ADR ($5,000 revenue)
    // Simple average ADR would be (200+50)/2 = $125
    // Weighted average ADR should be (2000+5000) / (10+100) = 7000 / 110 = $63.63
    
    const occRows = [
      { property_id: 'prop1', total_revenue: 2000, rooms_sold: 10, total_rooms: 10 },
      { property_id: 'prop2', total_revenue: 5000, rooms_sold: 100, total_rooms: 100 },
    ];
    
    const propertyRoomCounts = { prop1: 10, prop2: 100 };
    
    const result = CalculationService.calculateOccupancyMetrics(occRows, propertyRoomCounts);
    
    expect(result.revenue).toBe(7000);
    expect(result.roomsSold).toBe(110);
    expect(result.capacity).toBe(110);
    expect(result.occupancy).toBe(1); // 100%
    expect(result.adr).toBeCloseTo(63.64, 2); // 63.6363...
    expect(result.revpar).toBeCloseTo(63.64, 2); 
  });

  it('calculates portfolio RevPAR using a weighted average by available rooms', () => {
    // Property 1: 50 available rooms, 10 sold, $1,000 revenue. RevPAR = $20
    // Property 2: 150 available rooms, 150 sold, $15,000 revenue. RevPAR = $100
    // Simple average RevPAR = (20+100)/2 = $60
    // Weighted average RevPAR = (1000 + 15000) / (50 + 150) = 16000 / 200 = $80
    
    const occRows = [
      { property_id: 'prop1', total_revenue: 1000, rooms_sold: 10, total_rooms: 50 },
      { property_id: 'prop2', total_revenue: 15000, rooms_sold: 150, total_rooms: 150 },
    ];
    
    const propertyRoomCounts = { prop1: 50, prop2: 150 };
    
    const result = CalculationService.calculateOccupancyMetrics(occRows, propertyRoomCounts);
    
    expect(result.revenue).toBe(16000);
    expect(result.capacity).toBe(200);
    expect(result.revpar).toBe(80);
  });

  it('calculates capacity correctly with missing total_rooms by falling back to propertyRoomCounts', () => {
    const occRows = [
      // Missing total_rooms, should fall back to propertyRoomCounts
      { property_id: 'prop1', total_revenue: 1000, rooms_sold: 10 },
      // Has total_rooms, should override propertyRoomCounts
      { property_id: 'prop2', total_revenue: 2000, rooms_sold: 20, total_rooms: 120 }, 
    ];
    
    const propertyRoomCounts = { prop1: 50, prop2: 100 };
    
    const result = CalculationService.calculateOccupancyMetrics(occRows, propertyRoomCounts);
    
    // capacity should be 50 (from fallback) + 120 (from row override) = 170
    expect(result.capacity).toBe(170);
  });

  describe('Bulletproof Edge Cases', () => {
    it('handles zero capacity without throwing Infinity or NaN', () => {
      const occRows = [
        { property_id: 'prop1', total_revenue: 1000, rooms_sold: 10, total_rooms: 0 },
      ];
      const propertyRoomCounts = { prop1: 0 };
      
      const result = CalculationService.calculateOccupancyMetrics(occRows, propertyRoomCounts);
      
      expect(result.capacity).toBe(0);
      expect(result.occupancy).toBe(0); 
      expect(result.revpar).toBe(0);
      expect(result.adr).toBe(100); 
    });

    it('handles zero rooms sold (zero denominator for ADR)', () => {
      const occRows = [
        { property_id: 'prop1', total_revenue: 1000, rooms_sold: 0, total_rooms: 100 },
      ];
      const propertyRoomCounts = { prop1: 100 };
      
      const result = CalculationService.calculateOccupancyMetrics(occRows, propertyRoomCounts);
      
      expect(result.roomsSold).toBe(0);
      expect(result.adr).toBe(0); // Should safely return 0 instead of NaN/Infinity
    });

    it('handles negative revenue adjustments correctly', () => {
      const occRows = [
        { property_id: 'prop1', total_revenue: -500, rooms_sold: 10, total_rooms: 100 },
      ];
      const propertyRoomCounts = { prop1: 100 };
      
      const result = CalculationService.calculateOccupancyMetrics(occRows, propertyRoomCounts);
      
      expect(result.revenue).toBe(-500);
      expect(result.adr).toBe(-50);
      expect(result.revpar).toBe(-5);
    });

    it('handles string numeric inputs gracefully', () => {
      const occRows = [
        { property_id: 'prop1', total_revenue: "1000", rooms_sold: "10", total_rooms: "100" },
      ];
      const propertyRoomCounts = { prop1: 100 };
      
      const result = CalculationService.calculateOccupancyMetrics(occRows, propertyRoomCounts);
      
      expect(result.revenue).toBe(1000);
      expect(result.roomsSold).toBe(10);
      expect(result.capacity).toBe(100);
      expect(result.adr).toBe(100);
      expect(result.revpar).toBe(10);
    });
  });
});
