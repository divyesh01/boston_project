import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import RoomBoard from "@/pages/RoomBoard";

// Mock framer-motion to avoid animation issues in jsdom
vi.mock("framer-motion", () => ({
  motion: {
    div: ({ children, className, style, title, ...props }) => (
      <div className={className} style={style} title={title} {...props}>
        {children}
      </div>
    ),
  },
  AnimatePresence: ({ children }) => <>{children}</>,
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
}));

vi.mock("@/lib/realtime", () => ({
  useRealtimeInvalidation: vi.fn(),
}));

vi.mock("@/hooks/useSettingsVersion", () => ({
  useSettingsVersion: () => 1,
}));

vi.mock("@/lib/pricingSettings", () => ({
  isPricingEnabled: () => false,
  getPricingConfig: () => ({}),
  ROOM_TYPES: ["Standard", "Queen", "King"],
}));

vi.mock("@/lib/enterpriseConfigEngine", () => ({
  getEnterpriseConfig: () => ({}),
}));

// In-memory harness for testing RoomBoard
const filterState = {
  dateRange: { from: "2026-08-01", to: "2026-08-31" },
  property: "p1",
  properties: [{ id: "p1", name: "Boston Downtown", rooms: 2 }],
  months: [7], // August
  latestDate: "2026-08-10",
};

vi.mock("@/lib/useGlobalFilters", () => ({
  useGlobalFilters: () => filterState,
}));

const hotelDataState = {
  rooms: [
    { id: "r1", property_id: "p1", room_number: "101", room_type: "Standard", status: "available" },
    { id: "r2", property_id: "p1", room_number: "102", room_type: "Standard", status: "available" },
  ],
  stays: [],
  tasks: [],
  occ: [{ date: "2026-08-10", rooms_sold: 1, down_rooms: 0, room_revenue: 10000 }],
  roomsLoading: false,
  staysLoading: false,
  tasksLoading: false,
  occLoading: false,
  roomsError: null,
  staysError: null,
  tasksError: null,
  occError: null,
  lastStaysArgs: null,
  lastTasksArgs: null,
};

vi.mock("@/lib/useHotelData", () => ({
  useOccupancy: () => ({
    data: hotelDataState.occ,
    isLoading: hotelDataState.occLoading,
    isError: Boolean(hotelDataState.occError),
    error: hotelDataState.occError,
    refetch: vi.fn(),
  }),
  useRooms: () => ({
    data: hotelDataState.rooms,
    isLoading: hotelDataState.roomsLoading,
    isError: Boolean(hotelDataState.roomsError),
    error: hotelDataState.roomsError,
    refetch: vi.fn(),
  }),
  useRoomStays: (...args) => {
    hotelDataState.lastStaysArgs = args;
    return {
      data: hotelDataState.stays,
      isLoading: hotelDataState.staysLoading,
      isError: Boolean(hotelDataState.staysError),
      error: hotelDataState.staysError,
      refetch: vi.fn(),
    };
  },
  useHousekeepingTasks: (...args) => {
    hotelDataState.lastTasksArgs = args;
    return {
      data: hotelDataState.tasks,
      isLoading: hotelDataState.tasksLoading,
      isError: Boolean(hotelDataState.tasksError),
      error: hotelDataState.tasksError,
      refetch: vi.fn(),
    };
  },
  useReservations: () => ({ data: [], isLoading: false }),
  useWeatherSnapshots: () => ({ data: [] }),
}));

vi.mock("@/api/base44Client", () => ({
  db: {
    entities: {
      Room: { update: vi.fn(), bulkCreate: vi.fn() },
      RoomStay: { create: vi.fn() },
    },
  },
}));

describe("RoomBoard component behavior", () => {
  beforeEach(() => {
    filterState.dateRange = { from: "2026-08-01", to: "2026-08-31" };
    filterState.property = "p1";
    filterState.latestDate = "2026-08-10";
    hotelDataState.stays = [];
    hotelDataState.tasks = [];
    hotelDataState.roomsLoading = false;
    hotelDataState.staysLoading = false;
    hotelDataState.tasksLoading = false;
    hotelDataState.occLoading = false;
    hotelDataState.roomsError = null;
    hotelDataState.staysError = null;
    hotelDataState.tasksError = null;
    hotelDataState.occError = null;
    hotelDataState.lastStaysArgs = null;
    hotelDataState.lastTasksArgs = null;
  });

  it("fetches room stays and tasks using selected boardDate, not global dateRange", () => {
    render(<RoomBoard />);
    // Board date defaults to latestDate "2026-08-10"
    // useRoomStays must receive boardDate as its date query, NOT global dateRange
    expect(hotelDataState.lastStaysArgs[0]).toBe("2026-08-10");
    expect(hotelDataState.lastTasksArgs[0]).toBe("2026-08-10");
  });

  it("renders ErrorState on stay or task fetch failure and never shows vacant availability", () => {
    hotelDataState.staysError = new Error("Network timeout loading stays");
    render(<RoomBoard />);
    expect(screen.getByText("Could not load the room board")).toBeDefined();
    // Must NOT render Clean / Vacant room tiles
    expect(screen.queryByText("Clean Ready")).toBeNull();
  });

  it("renders loading state when stays or tasks are loading and never shows false vacant tiles", () => {
    hotelDataState.staysLoading = true;
    render(<RoomBoard />);
    expect(screen.getByText(/Loading property board/i)).toBeDefined();
    expect(screen.queryByText("Clean Ready")).toBeNull();
  });

  it("updates check-in date automatically with boardDate while default is active, but preserves manual check-in edit", () => {
    render(<RoomBoard />);

    const boardDateInput = /** @type {HTMLInputElement} */ (screen.getByLabelText(/Date/i));
    const checkInInput = /** @type {HTMLInputElement} */ (screen.getByLabelText(/Check-in/i));

    // Initial state: check-in follows boardDate "2026-08-10"
    expect(checkInInput.value).toBe("2026-08-10");

    // Change boardDate to 2026-08-15
    fireEvent.change(boardDateInput, { target: { value: "2026-08-15" } });
    // Check-in input must automatically follow boardDate
    expect(checkInInput.value).toBe("2026-08-15");

    // Now manually edit check-in input to 2026-08-20
    fireEvent.change(checkInInput, { target: { value: "2026-08-20" } });
    expect(checkInInput.value).toBe("2026-08-20");

    // Change boardDate again to 2026-08-25
    fireEvent.change(boardDateInput, { target: { value: "2026-08-25" } });
    // Explicit manual check-in date MUST BE PRESERVED
    expect(checkInInput.value).toBe("2026-08-20");
  });
});
