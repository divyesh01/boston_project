import sys

new_prompts = \"\"\"
### Category 11: Anomaly Detection, Chargebacks & POS Voids

#### Prompt 51

> **System Instruction**: You are an AI financial auditor. Chargebacks and credit card disputes must be reconciled against ledger settlement lines (FPCC) and guest folio remarks.
> **User Input**: *"A credit card chargeback of $285.00 was issued for folio AAA241 (Dena Hinds). Trace all ledger transactions for this folio in All Transactions.csv. Was the original payment settled, and what was the recorded transaction description?"*

#### Prompt 52

> **System Instruction**: Audit POS voids, check cancellations, and room service charge reversals.
> **User Input**: *"Scan the transactions ledger for any POS check numbers that were reversed or zeroed out on the same business date. Flag all usernames that executed POS charge cancellations exceeding $50.00."*

#### Prompt 53

> **System Instruction**: Evaluate employee rate overrides and unauthorized discount codes.
> **User Input**: *"Filter all ROOM CHARGES entries in July where the charged rate was lower than $50.00/night (excluding Group Block and Comp rooms). Identify the front-desk usernames responsible for applying these manual rate overrides."*

#### Prompt 54

> **System Instruction**: Reconcile advance deposit holdings against check-in folio transfers.
> **User Input**: *"Calculate total advance deposits (ADVANCE DEPOSIT) collected in June. Trace how much of that advance deposit volume was applied to July stays versus refunded or held in open balances."*

#### Prompt 55

> **System Instruction**: Audit late-night check-in rate manipulation patterns.
> **User Input**: *"Analyze room charges posted between 1:00 AM and 5:00 AM. Are late-night walk-in rates significantly lower than daytime walk-in rates for the same room type? Flag any clerk with a consistent late-night rate drop pattern."*

---

### Category 12: PMS Data Pipelines, File Auto-Detection & Deduplication

#### Prompt 56

> **System Instruction**: You are a data engineering AI. Explain how multi-worksheet and stacked section CSV files are parsed without data corruption.
> **User Input**: *"When a user uploads a Clerk Shift report containing stacked sections (Drops, Clerk Payments, Cash Audit), how does the parser identify section boundaries and select the final net payment block?"*

#### Prompt 57

> **System Instruction**: Evaluate database immutability during settings updates.
> **User Input**: *"If ownership changes the configured OTA commission rate for Expedia from 15% to 18%, explain why historical SourceDay rows in the database remain unchanged while future 'Money Kept' projections update instantly."*

#### Prompt 58

> **System Instruction**: Explain how the Universal Hotel Data Ingestion Engine handles unstructured Hotel Statistics exports.
> **User Input**: *"Explain how universalParser.js parses a 530-row Hotel Statistics snapshot that contains 'Actual Today', 'MTD', 'YTD', 'LY MTD', and 'LY YTD' in a single file without misaggregating overlapping periods."*

#### Prompt 59

> **System Instruction**: Evaluate fallback mechanisms when CSV files miss standardized headers.
> **User Input**: *"If a newly uploaded PMS report uses custom column titles like 'Nightly Rate' instead of 'ADR' or 'Gross Pay' instead of 'Total Revenue', how does COLUMN_MAP fuzzy matching resolve them?"*

#### Prompt 60

> **System Instruction**: Audit database schema migrations and cursor-based pagination.
> **User Input**: *"Explain how Dexie schema v6 composite indexes ([date+property_id], [property_id+expense_date]) optimize query speed when paginating across 100,000+ transaction lines."*

---

### Category 13: Complex Tax Windows, Exemptions & Jurisdictional Compliance

#### Prompt 61

> **System Instruction**: You are a hospitality tax compliance expert. Calculate room taxes using date-windowed rate structures.
> **User Input**: *"If Middleborough state tax is 11.70% and a local city tax of 2.50% takes effect on July 1, 2026, calculate total tax liability for a 5-night stay from June 28 to July 3 at $150.00/night."*

#### Prompt 62

> **System Instruction**: Distinguish between short-term taxable stays and extended-stay tax exemptions (30+ consecutive days).
> **User Input**: *"Guest Nicole Handricken stayed 30+ consecutive days in Room 138 (Confirmation RRI1416AAA085). Calculate the tax credit due to the guest once the stay crossed the 30-day tax exemption threshold."*

#### Prompt 63

> **System Instruction**: Audit tax liability on non-room revenue streams.
> **User Input**: *"Determine taxability across miscellaneous revenue lines: are pet fees, early check-in fees, meeting room rentals, and laundry services subject to state occupancy tax or local sales tax?"*

#### Prompt 64

> **System Instruction**: Compare PMS-reported tax lines against estimated tax calculations.
> **User Input**: *"When an imported PMS report contains explicit tax columns ('State Tax', 'City Tax'), why does eportParsers.js prioritize imported PMS tax values over estimated fallback percentages?"*

#### Prompt 65

> **System Instruction**: Model tax liabilities for complimentary and house-use rooms.
> **User Input**: *"If local tax law mandates that complimentary rooms (Comp) provided for marketing purposes are taxable based on fair market value ($100/night), what is our monthly tax obligation on 12 Comp rooms in July?"*

---

### Category 14: Labor Productivity, Shift Scheduling & Housekeeping Metrics

#### Prompt 66

> **System Instruction**: You are a hotel labor efficiency analyst. Evaluate staffing ratios relative to occupied rooms.
> **User Input**: *"Our housekeeping benchmark is 30 minutes per stayover room and 45 minutes per checkout room. In July (2,619 stays, 400 checkouts), how many total housekeeping labor hours were required, and did our actual payroll align with this benchmark?"*

#### Prompt 67

> **System Instruction**: Evaluate front-desk checking efficiency and labor cost per check-in.
> **User Input**: *"Front desk labor for July totaled $4,200 across 1,800 total check-in events. What was our front-desk labor cost per check-in, and how can shift scheduling be optimized during peak 3:00 PM – 7:00 PM arrival windows?"*

#### Prompt 68

> **System Instruction**: Model labor savings from flexible vs. fixed scheduling.
> **User Input**: *"If Tuesday and Wednesday occupancy averages 45% while Friday and Saturday average 92%, calculate the cost savings of moving from fixed 8-hour front-desk shifts to dynamic flexible staffing during low-demand mid-week days."*

#### Prompt 69

> **System Instruction**: Evaluate salary vs. hourly labor cost stability during seasonal fluctuations.
> **User Input**: *"Compare total labor cost flexibility between a property with 100% hourly staff versus a property with 40% salaried managers during a 50% drop in seasonal revenue."*

#### Prompt 70

> **System Instruction**: Evaluate employee turnover cost and training drag.
> **User Input**: *"If replacing a front desk clerk costs $2,200 in recruiting and lost productivity, what is the annual financial impact of a 40% turnover rate across a 10-person staff?"*

---

### Category 15: Meta-Search Bidding, OTA Commissions & Distribution Yield

#### Prompt 71

> **System Instruction**: You are a digital distribution strategist. Evaluate meta-search ad spend (Google Hotel Ads, TripAdvisor) against OTA commission savings.
> **User Input**: *"If Google Hotel Ads charges an 8% pay-per-stay commission and generates 60 bookings at an ADR of $150.00, calculate the net dollar savings compared to acquiring those same 60 bookings through Expedia at 15% commission."*

#### Prompt 72

> **System Instruction**: Audit OTA commission rate changes and contract compliance.
> **User Input**: *"Review all Expedia bookings in July. Did Expedia deduct exactly the contracted 15% commission, or were there additional merchant processing fees or promotional participation deductions?"*

#### Prompt 73

> **System Instruction**: Evaluate rate parity violations across third-party OTAs.
> **User Input**: *"If Agoda lists our rooms at $120.00/night while our brand website lists $135.00/night (rate parity violation), calculate the net profit loss if 30 direct guests book through Agoda instead."*

#### Prompt 74

> **System Instruction**: Analyze Wholesaler / GDS net yield margins.
> **User Input**: *"Compare net yield across Sabre (GDS), Agoda, and Walk-in for July 2026. Which channel provided the highest net revenue after factoring in GDS transaction fees ($4.50/booking) plus travel agent commissions (10%)?"*

#### Prompt 75

> **System Instruction**: Model opaque channel discounting (Hotwire / Priceline Express).
> **User Input**: *"When should a hotel open opaque discount channels (Hotwire) to clear distressed inventory, and what rate floor should be set to protect brand equity and avoid cannibalizing direct bookings?"*

---

### Category 16: Property Improvement Plans (PIP), CapEx & Valuation

#### Prompt 76

> **System Instruction**: You are a hotel asset manager. Calculate Return on Invested Capital (ROIC) for property renovations.
> **User Input**: *"Ownership is planning a $150,000 Property Improvement Plan (PIP) to renovate 50 guest rooms. If the renovation allows us to increase ADR by $12.00 at 70% annual occupancy, what is the ROIC and payback period in years?"*

#### Prompt 77

> **System Instruction**: Evaluate CapEx investment in energy-efficiency upgrades.
> **User Input**: *"Installing smart thermostats costs $12,000 for 100 rooms and is projected to reduce monthly electric bills by 12% ($800/month savings). What is the internal rate of return (IRR) over a 5-year period?"*

#### Prompt 78

> **System Instruction**: Analyze room lock system upgrade economics.
> **User Input**: *"Upgrading to RFID/Mobile Key locks costs $18,000. If mobile check-in reduces front-desk labor by 10 hours/week at $16/hour and eliminates physical keycard replacement costs ($500/year), calculate the payback period."*

#### Prompt 79

> **System Instruction**: Model asset valuation impact from RevPAR growth.
> **User Input**: *"If a successful revenue management strategy increases property RevPAR from $47.26 to $58.00 across 100 rooms, calculate the increase in annual gross revenue and the resulting increase in property valuation at an 8.5% Cap Rate."*

#### Prompt 80

> **System Instruction**: Evaluate franchise fee structures and brand royalty costs.
> **User Input**: *"Red Roof franchise fees consist of a 4.5% royalty fee and a 4.0% marketing/reservation fee on gross room revenue. Calculate total franchise fees paid in July ($231,075.29 revenue) and evaluate net revenue retained by ownership."*

---

### Category 17: Crisis Management, Demand Shocks & Weather Disruptions

#### Prompt 81

> **System Instruction**: You are an operational risk manager. Model financial survival strategies during severe weather shocks.
> **User Input**: *"A severe winter blizzard in January forces a 3-day highway closure, dropping occupancy to 8%. What immediate emergency cost-containment measures should be taken regarding hourly labor and utility setbacks?"*

#### Prompt 82

> **System Instruction**: Analyze emergency contract revenue during local disasters or state emergencies.
> **User Input**: *"During a regional emergency, state agencies request 30 rooms for 14 days at a capped government rate of $75.00/night (tax-exempt). Calculate total guaranteed contract revenue and compare it against standard off-peak forecasts."*

#### Prompt 83

> **System Instruction**: Evaluate insurance claim preparation for property damage and business interruption.
> **User Input**: *"A water pipe burst disables 10 rooms for 21 days during peak July ($189.55 ADR, 85% occupancy). Calculate the business interruption claim amount based on lost room revenue minus saved variable costs."*

#### Prompt 84

> **System Instruction**: Evaluate price gouging compliance during high-demand crisis events.
> **User Input**: *"State law prohibits raising lodging rates by more than 15% during a declared state of emergency. If our pre-emergency rack rate was $110.00, what is the maximum legal rate we can charge?"*

#### Prompt 85

> **System Instruction**: Model demand recovery curves following a market downturn.
> **User Input**: *"Following a regional economic downturn, lodging demand drops by 20% across the market. Should ownership lower rates to capture market share or hold ADR to protect brand positioning? Model both scenarios."*

---

### Category 18: Owner Reporting, Waterfall Charts & Investor Communications

#### Prompt 86

> **System Instruction**: You are an executive assistant preparing a monthly board report.
> **User Input**: *"Prepare a 1-page executive summary comparing Q1 2026 performance against budget. Structure the report into 3 sections: Top-Line Performance (Revenue/ADR/RevPAR), Cost & Labor Control, and Net Cash Flow for Ownership."*

#### Prompt 87

> **System Instruction**: Construct a revenue-to-profit waterfall analysis breakdown.
> **User Input**: *"Construct a financial waterfall breakdown for July starting from Gross Revenue ($231,075.29) and deducting: OTA Commissions, Credit Card Fees, Estimated Taxes, Operating Expenses, and Payroll to arrive at 'Money Kept'."*

#### Prompt 88

> **System Instruction**: Analyze capital distribution capacity after debt service and reserves.
> **User Input**: *"July generated ~$218,500 in net operating income. After deducting $15,000 debt service, $9,200 CapEx reserve, and $20,000 winter cash reserve, what is the net dividend distribution available for equity partners?"*

#### Prompt 89

> **System Instruction**: Generate a multi-property equity partner performance card.
> **User Input**: *"Create a side-by-side comparison card for equity partners showing Middleborough vs. Phoenix West across 4 KPIs: Cash-on-Cash Return, Operating Margin %, RevPAR Index, and Labor Cost %."*

#### Prompt 90

> **System Instruction**: Prepare a variance explanation report for actual vs. budgeted operating costs.
> **User Input**: *"Operating expenses in July were $1,200 over budget due to emergency air conditioning repairs. Draft a professional 2-sentence variance explanation for inclusion in the monthly owner financial package."*

---

### Category 19: AI System Prompt Tuning & Edge Case Handling

#### Prompt 91

> **System Instruction**: You are an AI assistant. When financial data is missing or incomplete, explicitly list the missing data required rather than guessing.
> **User Input**: *"What was our net profit for Phoenix West in July 2026?"*
> *(Context: Phoenix West has 0 uploaded reports in the database)*

#### Prompt 92

> **System Instruction**: Handle ambiguous property references by asking for clarification or searching all properties.
> **User Input**: *"What was revenue last week?"*
> *(Context: Multi-property database contains Middleborough and Phoenix West)*

#### Prompt 93

> **System Instruction**: Ensure all currency values preserve sign and display negative losses correctly.
> **User Input**: *"Format a net operating loss of $1,450.75 and a net profit of $12,300.00 using standard financial formatting."*

#### Prompt 94

> **System Instruction**: Enforce strict role-based data visibility for 'Front Desk' accounts.
> **User Input**: *"A user logged in as 'Front Desk' asks: 'What was the property's net profit margin and owner distribution last month?' How should the AI respond?"*

#### Prompt 95

> **System Instruction**: Validate date range parameter extraction for custom query strings.
> **User Input**: *"Extract the start date, end date, and target property from the query: 'Compare revenue between June 1st 2026 and July 15th 2026 for Middleborough'."*

---

### Category 20: Comprehensive Final Integration Prompts

#### Prompt 96

> **System Instruction**: Perform a complete top-to-bottom P&L, channel, and labor audit for a single business date.
> **User Input**: *"Perform a complete daily audit for July 15, 2026: Total Revenue, Occupancy %, ADR, RevPAR, Top Channel by Revenue, Front Desk Cash Variances, and Total Daily Payroll Cost."*

#### Prompt 97

> **System Instruction**: Evaluate the net financial impact of accepting a corporate extended-stay agreement.
> **User Input**: *"A corporate client offers to contract 10 rooms for 90 days (July through September) at $85.00/night tax-exempt. Calculate total guaranteed revenue, compare against forecasted peak/off-peak revenue, and recommend a decision."*

#### Prompt 98

> **System Instruction**: Model the financial impact of automated keyless check-in on front desk staffing hours.
> **User Input**: *"If 40% of guests adopt automated mobile check-in, reducing front desk check-in workload by 15 hours/week, calculate the annual labor savings at an average wage of $16.50/hour."*

#### Prompt 99

> **System Instruction**: Compare gross revenue vs. net retained revenue across all third-party channels for Q2 2026.
> **User Input**: *"Across Q2 2026 (April–June), calculate total gross revenue generated by third-party OTAs, total commissions paid, total credit card fees incurred, and net cash retained by the property."*

#### Prompt 100

> **System Instruction**: You are Gemini Spark / Red Roof Intelligence AI. Deliver a comprehensive master summary of property performance for hotel ownership.
> **User Input**: *"Provide a master performance summary for Red Roof Inn & Suites Middleborough covering YTD 2026 performance: Total Revenue, Net Profit ('Money Kept'), Average Occupancy, Average ADR, Top Producing Channel, and Top Priority for Q3 Optimization."*
\"\"\"

try:
    with open('BUSINESS.md', 'a', encoding='utf-8') as f:
        f.write(\"\\n\" + new_prompts + \"\\n\")
    print(\"Successfully appended the next batch of 50 prompts to BUSINESS.md\")
except Exception as e:
    print(f\"Error: {e}\")
    sys.exit(1)
