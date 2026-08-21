// Event schedule data for demand-based pricing intelligence.
// Shared by the Action Center and Monthly Calendar views.
// Motel base: 30 East Clark Street, Middleborough, MA

export const EVENT_SCHEDULE = [
  { date: "2026-08-21", name: "Kesha", venue: "The Xfinity Center", address: "885 S Main St, Mansfield, MA 02048", time: "7:00 PM", type: "Pop / Dance Concert", holiday: "Summer Tour Season", demand: "High", priceRange: "$60-$220+", distance: 22, audience: "Adults (21-35), pop fans, regional concertgoers across SE Mass & RI" },
  { date: "2026-08-22", name: "Patriots vs Eagles (NFL Preseason)", venue: "Gillette Stadium", address: "1 Patriot Pl, Foxborough, MA 02035", time: "7:00 PM", type: "NFL Preseason", holiday: "NFL Preseason", demand: "High", priceRange: "$75-$250+", distance: 28, audience: "Sports fans, tailgaters, out-of-state visiting Philadelphia fans" },
  { date: "2026-08-23", name: "Revolution vs NYCFC (MLS Rivalry)", venue: "Gillette Stadium", address: "1 Patriot Pl, Foxborough, MA 02035", time: "4:30 PM", type: "Major League Soccer Rivalry Match", holiday: "Late Summer MLS", demand: "Moderate to High", priceRange: "$35-$140+", distance: 28, audience: "Regional soccer supporters, visiting New York travelers" },
  { date: "2026-08-28", name: "Empire of the Sun", venue: "The Xfinity Center", address: "885 S Main St, Mansfield, MA 02048", time: "7:30 PM", type: "Alt-Electronic Concert", holiday: "College Move-in Weekend", demand: "High", priceRange: "$55-$180+", distance: 22, audience: "College students, young professionals, music travelers" },
  { date: "2026-08-28", name: "Savannah Bananas World Tour (Day 1)", venue: "Gillette Stadium", address: "1 Patriot Pl, Foxborough, MA 02035", time: "6:30 PM", type: "Banana Ball Stadium Show - Sellout", holiday: "Regional Move-in Weekend", demand: "Very High", priceRange: "$50-$250+ (resale $150-$400)", distance: 28, audience: "Families with kids, nationwide sports fans" },
  { date: "2026-08-29", name: "Savannah Bananas World Tour (Day 2)", venue: "Gillette Stadium", address: "1 Patriot Pl, Foxborough, MA 02035", time: "6:30 PM", type: "Banana Ball Stadium Show - Sellout", holiday: "Regional Move-in Weekend", demand: "Very High", priceRange: "$50-$250+ (resale $150-$400)", distance: 28, audience: "Families with kids, nationwide sports fans" },
  { date: "2026-08-29", name: "Pitbull with Lil Jon: I'm Back Tour", venue: "The Xfinity Center", address: "885 S Main St, Mansfield, MA 02048", time: "7:00 PM", type: "High-Energy Hip-Hop/Pop Concert", holiday: "Summer Tour Weekend", demand: "Very High", priceRange: "$80-$350+", distance: 22, audience: "Adults (21-45), nightlife party groups, high beverage spenders" },
  { date: "2026-08-29", name: "WaterFire Providence Full Lighting", venue: "Waterplace Park / Basin", address: "10 Memorial Blvd, Providence, RI 02903", time: "Sunset-11:00 PM", type: "Urban Bonfire & Arts Experience", holiday: "Summer Arts Tourism", demand: "High", priceRange: "Free ($100+ dining/hotel spend)", distance: 32, audience: "Couples, cultural tourists, regional day-trippers" },
  { date: "2026-08-30", name: "TLC & Salt-N-Pepa with En Vogue", venue: "The Xfinity Center", address: "885 S Main St, Mansfield, MA 02048", time: "7:00 PM", type: "90s R&B / Hip-Hop Concert", holiday: "End of Summer Weekend", demand: "High", priceRange: "$60-$240+", distance: 22, audience: "Gen X & Millennials (30-55), groups of friends" },
  { date: "2026-08-31", name: "Boston Legacy FC vs Angel City FC", venue: "Gillette Stadium", address: "1 Patriot Pl, Foxborough, MA 02035", time: "8:00 PM", type: "NWSL Inaugural Season Pro Women's Soccer", holiday: "College Move-in Week", demand: "Moderate to High", priceRange: "$30-$130+", distance: 28, audience: "Families, youth soccer clubs, women's sports supporters" },
  { date: "2026-09-05", name: "Bruno Mars: The Romantic Tour (Day 1)", venue: "Gillette Stadium", address: "1 Patriot Pl, Foxborough, MA 02035", time: "7:00 PM", type: "Mega Stadium Concert (65,000+)", holiday: "Labor Day Weekend", demand: "Maximum", priceRange: "$150-$650+ (VIP $1,000+)", distance: 28, audience: "High-income pop music fans, travelers from across the US" },
  { date: "2026-09-06", name: "Bruno Mars: The Romantic Tour (Day 2)", venue: "Gillette Stadium", address: "1 Patriot Pl, Foxborough, MA 02035", time: "7:00 PM", type: "Mega Stadium Concert (65,000+)", holiday: "Labor Day Weekend", demand: "Maximum", priceRange: "$150-$650+ (VIP $1,000+)", distance: 28, audience: "High-income pop music fans, travelers from across the US" },
  { date: "2026-09-08", name: "$uicideboy$: Grey Day Tour 2026", venue: "The Xfinity Center", address: "885 S Main St, Mansfield, MA 02048", time: "6:30 PM", type: "Hip-Hop / Rap Concert", holiday: "Midweek Tour Date", demand: "High", priceRange: "$70-$250+", distance: 22, audience: "Young adults (18-30), dedicated tour followers" },
  { date: "2026-09-10", name: "BABYMETAL World Tour 2026", venue: "The Xfinity Center", address: "885 S Main St, Mansfield, MA 02048", time: "7:00 PM", type: "Metal / J-Pop Concert", holiday: "Midweek Tour Date", demand: "High", priceRange: "$60-$200+", distance: 22, audience: "Anime and metal fans traveling regionally" },
  { date: "2026-09-11", name: "The Hayley Williams Show", venue: "The Xfinity Center", address: "885 S Main St, Mansfield, MA 02048", time: "7:30 PM", type: "Alt-Rock / Pop Concert", holiday: "Fall Weekend", demand: "High", priceRange: "$75-$280+", distance: 22, audience: "Millennial & Gen Z rock fans" },
  { date: "2026-09-12", name: "Wu-Tang Clan: The Final Chamber", venue: "The Xfinity Center", address: "885 S Main St, Mansfield, MA 02048", time: "7:00 PM", type: "Hip-Hop Anniversary Tour", holiday: "Fall Weekend", demand: "Very High", priceRange: "$80-$350+", distance: 22, audience: "Adults (25-50), hip-hop enthusiasts" },
  { date: "2026-09-12", name: "Karol G: VIAJANDO POR EL MUNDO TROPITOUR", venue: "Gillette Stadium", address: "1 Patriot Pl, Foxborough, MA 02035", time: "7:00 PM", type: "Global Latin Stadium Mega-Concert (65,000+)", holiday: "Peak September Concert Season", demand: "Maximum", priceRange: "$130-$600+ (VIP $900+)", distance: 28, audience: "Massive Latin music fanbase traveling from MA, RI, NY, CT and nationwide" },
  { date: "2026-09-13", name: "Benson's Pond Cranberry Harvest Festival", venue: "Bensons Pond Barn", address: "6 Pine St, Middleborough, MA 02346", time: "10:00 AM-4:00 PM", type: "Cranberry Bog Demos, Wagon Rides, Food Trucks", holiday: "Local Harvest Festival", demand: "Moderate to High", priceRange: "$15-$35", distance: 4, audience: "Day-trippers, local families, autumn tourists" },
  { date: "2026-09-18", name: "Staind: Break The Cycle 25th Anniversary", venue: "The Xfinity Center", address: "885 S Main St, Mansfield, MA 02048", time: "7:00 PM", type: "Hard Rock Concert", holiday: "Fall Weekend", demand: "High", priceRange: "$60-$220+", distance: 22, audience: "Rock/metal fans (30-55), regional New Englanders" },
  { date: "2026-09-19", name: "Dan + Shay: The Young Tour", venue: "The Xfinity Center", address: "885 S Main St, Mansfield, MA 02048", time: "7:00 PM", type: "Country / Pop Concert", holiday: "Fall Weekend", demand: "Very High", priceRange: "$70-$300+", distance: 22, audience: "Country music fans, couples, social groups" },
  { date: "2026-09-19", name: "Revolution vs Orlando City SC", venue: "Gillette Stadium", address: "1 Patriot Pl, Foxborough, MA 02035", time: "7:30 PM", type: "MLS Home Match", holiday: "Fall Sports Weekend", demand: "Moderate to High", priceRange: "$35-$150+", distance: 28, audience: "Regional soccer fans, families" },
  { date: "2026-09-20", name: "Patriots vs Steelers (Home Opener)", venue: "Gillette Stadium", address: "1 Patriot Pl, Foxborough, MA 02035", time: "1:00 PM", type: "NFL Regular Season", holiday: "NFL Home Opener", demand: "Maximum", priceRange: "$150-$500+", distance: 28, audience: "Steelers traveling fans ('Steeler Nation'), tailgaters" },
  { date: "2026-09-22", name: "Bryson Tiller: The Neo Trapsoul Tour", venue: "The Xfinity Center", address: "885 S Main St, Mansfield, MA 02048", time: "7:30 PM", type: "R&B / Hip-Hop Concert", holiday: "Midweek Tour Date", demand: "Moderate to High", priceRange: "$65-$220+", distance: 22, audience: "Young adults, R&B fans" },
  { date: "2026-09-25", name: "Ed Sheeran: LOOP Tour (Day 1)", venue: "Gillette Stadium", address: "1 Patriot Pl, Foxborough, MA 02035", time: "7:00 PM", type: "Stadium Tour w/ Macklemore (65,000+)", holiday: "Peak Fall Weekend", demand: "Maximum", priceRange: "$120-$550+", distance: 28, audience: "Broad multi-generational audience, major interstate travel" },
  { date: "2026-09-26", name: "Ed Sheeran: LOOP Tour (Day 2)", venue: "Gillette Stadium", address: "1 Patriot Pl, Foxborough, MA 02035", time: "7:00 PM", type: "Stadium Tour w/ Macklemore (65,000+)", holiday: "Peak Fall Weekend", demand: "Maximum", priceRange: "$120-$550+", distance: 28, audience: "Broad multi-generational audience, major interstate travel" },
  { date: "2026-10-02", name: "Zach Bryan: With Heaven On Tour (Day 1)", venue: "Gillette Stadium", address: "1 Patriot Pl, Foxborough, MA 02035", time: "7:00 PM", type: "Country / Folk Stadium Concert", holiday: "Fall Foliage Season", demand: "Maximum", priceRange: "$140-$600+", distance: 28, audience: "Country/folk fans, heavy out-of-state lodging demand" },
  { date: "2026-10-03", name: "Zach Bryan: With Heaven On Tour (Day 2)", venue: "Gillette Stadium", address: "1 Patriot Pl, Foxborough, MA 02035", time: "7:00 PM", type: "Country / Folk Stadium Concert", holiday: "Fall Foliage Season", demand: "Maximum", priceRange: "$140-$600+", distance: 28, audience: "Country/folk fans, heavy out-of-state lodging demand" },
  { date: "2026-10-10", name: "Annual Cranberry Harvest Celebration (Day 1)", venue: "A.D. Makepeace / Tihonet Pond", address: "158 Tihonet Rd, Wareham, MA 02571", time: "10:00 AM-4:00 PM", type: "Wet Bog Harvest, Helicopter Tours, Crafts", holiday: "Columbus / Indigenous Peoples Day", demand: "Very High", priceRange: "$10-$20 ($100+ helicopter/activities)", distance: 12, audience: "Families, photographers, New England autumn tourists" },
  { date: "2026-10-10", name: "Revolution vs Seattle Sounders FC", venue: "Gillette Stadium", address: "1 Patriot Pl, Foxborough, MA 02035", time: "7:30 PM", type: "MLS Home Match", holiday: "Columbus / Indigenous Peoples Day", demand: "High", priceRange: "$40-$160+", distance: 28, audience: "Holiday weekend travelers, West Coast visiting soccer supporters" },
  { date: "2026-10-11", name: "Annual Cranberry Harvest Celebration (Day 2)", venue: "A.D. Makepeace / Tihonet Pond", address: "158 Tihonet Rd, Wareham, MA 02571", time: "10:00 AM-4:00 PM", type: "Wet Bog Harvest, Helicopter Tours, Crafts", holiday: "Columbus / Indigenous Peoples Day", demand: "Very High", priceRange: "$10-$20 ($100+ helicopter/activities)", distance: 12, audience: "Families, photographers, New England autumn tourists" },
  { date: "2026-10-11", name: "Patriots vs Las Vegas Raiders", venue: "Gillette Stadium", address: "1 Patriot Pl, Foxborough, MA 02035", time: "1:00 PM", type: "NFL Regular Season", holiday: "Columbus / Indigenous Peoples Day", demand: "Maximum", priceRange: "$120-$450+", distance: 28, audience: "Traveling Raiders fans, long-weekend vacationers" },
  { date: "2026-10-16", name: "Boston Legacy FC vs Racing Louisville FC", venue: "Gillette Stadium", address: "1 Patriot Pl, Foxborough, MA 02035", time: "8:00 PM", type: "NWSL Home Match", holiday: "Fall Sports Weekend", demand: "Moderate", priceRange: "$30-$120+", distance: 28, audience: "Local sports families, visiting supporters" },
  { date: "2026-10-17", name: "WaterFire Providence Full Lighting", venue: "Waterplace Park / Basin", address: "10 Memorial Blvd, Providence, RI 02903", time: "Sunset-11:00 PM", type: "Autumn Evening Arts Festival", holiday: "Fall Weekend", demand: "High", priceRange: "Free ($100+ incidental spend)", distance: 32, audience: "Couples, tourists, regional travelers" },
  { date: "2026-10-17", name: "Revolution vs Chicago Fire FC", venue: "Gillette Stadium", address: "1 Patriot Pl, Foxborough, MA 02035", time: "7:30 PM", type: "MLS Home Match", holiday: "Head of the Charles Weekend", demand: "High", priceRange: "$35-$150+", distance: 28, audience: "Regional soccer fans, Midwest travelers" },
  { date: "2026-10-28", name: "Revolution vs New York Red Bulls", venue: "Gillette Stadium", address: "1 Patriot Pl, Foxborough, MA 02035", time: "7:30 PM", type: "MLS Rivalry Match", holiday: "Midweek Pre-Halloween", demand: "Moderate to High", priceRange: "$35-$140+", distance: 28, audience: "I-95 corridor travelers from NY/NJ" },
  { date: "2026-10-18", name: "Patriots vs New York Jets", venue: "Gillette Stadium", address: "1 Patriot Pl, Foxborough, MA 02035", time: "1:00 PM", type: "NFL AFC East Rivalry Game", holiday: "Fall Football Season", demand: "Very High", priceRange: "$130-$480+", distance: 28, audience: "Heavy influx of NY/NJ drivers along I-95/I-495" },
  { date: "2026-10-31", name: "Navy vs Notre Dame Football Classic", venue: "Gillette Stadium", address: "1 Patriot Pl, Foxborough, MA 02035", time: "12:00 PM (Noon)", type: "Historic College Football Rivalry Game", holiday: "Halloween Weekend", demand: "Maximum", priceRange: "$150-$600+", distance: 28, audience: "Notre Dame alumni and Naval Academy families nationwide" },
  { date: "2026-11-01", name: "Revolution vs Inter Miami CF", venue: "Gillette Stadium", address: "1 Patriot Pl, Foxborough, MA 02035", time: "7:00 PM", type: "MLS Match - High-Demand National Draw", holiday: "Post-Halloween Weekend", demand: "Very High", priceRange: "$125-$500+", distance: 28, audience: "Major interstate soccer draw, high secondary market ticket prices" },
  { date: "2026-11-08", name: "Patriots vs Green Bay Packers", venue: "Gillette Stadium", address: "1 Patriot Pl, Foxborough, MA 02035", time: "4:25 PM", type: "NFL Late Afternoon Marquee Game", holiday: "NFL Football Season", demand: "Maximum", priceRange: "$160-$550+", distance: 28, audience: "Packers fans travel nationwide; fills I-495 hotels" },
  { date: "2026-11-11", name: "Veterans Day Observances & Parades", venue: "Regional Sites (Middleborough, Plymouth, Taunton)", address: "Regional", time: "All Day", type: "Veterans Day Parade", holiday: "Veterans Day", demand: "Moderate", priceRange: "Free", distance: 0, audience: "Military families, local community members" },
  { date: "2026-12-06", name: "Patriots vs Buffalo Bills", venue: "Gillette Stadium", address: "1 Patriot Pl, Foxborough, MA 02035", time: "4:25 PM", type: "NFL AFC East Division Rivalry", holiday: "NFL Winter Season", demand: "Very High", priceRange: "$120-$450+", distance: 28, audience: "Bills Mafia traveling fan base filling highway motels" },
  { date: "2026-12-10", name: "Patriots vs Minnesota Vikings (TNF)", venue: "Gillette Stadium", address: "1 Patriot Pl, Foxborough, MA 02035", time: "8:15 PM", type: "Thursday Night Football - Primetime NFL", holiday: "Midweek Primetime NFL", demand: "Very High", priceRange: "$140-$500+", distance: 28, audience: "Late finish (~11:30 PM); fans avoid night drives and book motels" },
  { date: "2026-12-24", name: "Christmas Eve", venue: "Regional", address: "Regional", time: "All Day", type: "Christmas Holiday", holiday: "Christmas", demand: "Moderate", priceRange: "Family travelers", distance: 0, audience: "Visiting family members and holiday travelers" },
  { date: "2026-12-25", name: "Christmas Day", venue: "Regional", address: "Regional", time: "All Day", type: "Christmas Holiday", holiday: "Christmas", demand: "Moderate", priceRange: "Family travelers", distance: 0, audience: "Visiting family members and holiday travelers" },
  { date: "2026-12-31", name: "New Year's Eve WaterFire & Parties", venue: "Waterplace Park / Downtown", address: "10 Memorial Blvd, Providence, RI 02903", time: "5:00 PM-1:00 AM", type: "NYE Lighting & Regional Parties", holiday: "New Year's Eve", demand: "High", priceRange: "$50-$250+ party tickets / Free lightings", distance: 32, audience: "Nightlife revelers, couples seeking post-midnight lodging" },
  // ── Historical 2026 H1 (Jan 1 – Aug 19) retrospective — benchmark for pricing ──
  { date: "2026-06-22", name: "Mumford & Sons", venue: "Fenway Park", address: "4 Jersey St, Boston, MA 02215", time: "8:00 PM", type: "Folk-Rock Ballpark Concert", holiday: "Summer Ballpark Tour", demand: "High", priceRange: "$85-$300+", distance: 38, audience: "Music travelers, folk-rock enthusiasts" },
  { date: "2026-07-08", name: "Lionel Richie & Earth, Wind & Fire", venue: "TD Garden", address: "100 Legends Way, Boston, MA 02114", time: "7:30 PM", type: "Classic R&B / Soul Arena Tour", holiday: "Midweek Arena Tour", demand: "High", priceRange: "$70-$280+", distance: 38, audience: "Adults (35-65), couples, nostalgic music travelers" },
  { date: "2026-07-18", name: "Muse", venue: "The Xfinity Center", address: "885 S Main St, Mansfield, MA 02048", time: "6:00 PM", type: "Alternative / Prog-Rock Tour", holiday: "Summer Weekend", demand: "High", priceRange: "$65-$240+", distance: 22, audience: "Rock fans (20-45) traveling from MA and RI" },
  { date: "2026-07-24", name: "John Mellencamp", venue: "The Xfinity Center", address: "885 S Main St, Mansfield, MA 02048", time: "7:00 PM", type: "Heartland Rock Tour", holiday: "Summer Weekend", demand: "High", priceRange: "$60-$220+", distance: 22, audience: "Classic rock fans (40-65)" },
  { date: "2026-07-31", name: "Linkin Park: From Zero World Tour", venue: "TD Garden", address: "100 Legends Way, Boston, MA 02114", time: "7:30 PM", type: "Rock / Nu-Metal Arena Show", holiday: "Arena Concert", demand: "Very High", priceRange: "$85-$350+", distance: 38, audience: "Rock/metal fans across New England" },
  { date: "2026-08-01", name: "Mötley Crüe: Return of the Carnival of Sins", venue: "The Xfinity Center", address: "885 S Main St, Mansfield, MA 02048", time: "7:00 PM", type: "Heavy Metal Tour", holiday: "Peak Summer Weekend", demand: "Very High", priceRange: "$75-$320+", distance: 22, audience: "Rock/metal fans, tailgaters" },
  { date: "2026-08-02", name: "Zac Brown Band with Old Crow Medicine Show", venue: "Fenway Park", address: "4 Jersey St, Boston, MA 02215", time: "6:30 PM", type: "Country Ballpark Concert", holiday: "Summer Ballpark Tour", demand: "Very High", priceRange: "$80-$320+", distance: 38, audience: "Country music fans, couples, regional groups" },
  { date: "2026-08-12", name: "Avenged Sevenfold & Good Charlotte", venue: "The Xfinity Center", address: "885 S Main St, Mansfield, MA 02048", time: "6:30 PM", type: "Alt-Metal / Pop-Punk Tour", holiday: "Midweek Tour Date", demand: "High", priceRange: "$60-$220+", distance: 22, audience: "Rock and punk enthusiasts (20-40)" },
  { date: "2026-08-17", name: "Chris Brown & USHER: The R&B Tour", venue: "Gillette Stadium", address: "1 Patriot Pl, Foxborough, MA 02035", time: "7:00 PM", type: "Major Stadium R&B Concert", holiday: "Stadium Tour Series", demand: "Very High", priceRange: "$120-$500+", distance: 28, audience: "R&B fans (25-50), high disposable income" },
  { date: "2026-08-19", name: "Durand Bernarr, TheARTI$t, WASEEL, Dixson", venue: "MGM Music Hall at Fenway", address: "2 Lansdowne St, Boston, MA 02215", time: "6:30 PM", type: "Soul / R&B Concert", holiday: "Midweek Tour Date", demand: "Moderate to High", priceRange: "$45-$120+", distance: 38, audience: "Urban music fans, Boston travelers" },
  // ── Historical Gillette Stadium matches (GoTickets schedule, Jan – Aug 19, 2026) ──
  { date: "2026-06-13", name: "FIFA World Cup: Haiti vs Scotland", venue: "Gillette Stadium", address: "1 Patriot Pl, Foxborough, MA 02035", time: "7:00 PM", type: "World Cup Group C Match (Match 1 at Boston)", holiday: "World Cup Opening Weekend", demand: "Maximum", priceRange: "$180-$950+", distance: 28, audience: "International traveling fans, Scottish and Haitian diaspora across the US" },
  { date: "2026-06-16", name: "FIFA World Cup: Iraq vs Norway", venue: "Gillette Stadium", address: "1 Patriot Pl, Foxborough, MA 02035", time: "4:00 PM", type: "World Cup Group I Match", holiday: "World Cup Tournament", demand: "Maximum", priceRange: "$160-$850+", distance: 28, audience: "International soccer travelers, European tourists" },
  { date: "2026-06-19", name: "FIFA World Cup: Scotland vs Morocco", venue: "Gillette Stadium", address: "1 Patriot Pl, Foxborough, MA 02035", time: "7:00 PM", type: "World Cup Group C Match", holiday: "Juneteenth Weekend", demand: "Maximum", priceRange: "$200-$1,100+", distance: 28, audience: "Massive traveling supporter groups filling hotels across Eastern MA and RI" },
  { date: "2026-06-23", name: "FIFA World Cup: England vs Ghana", venue: "Gillette Stadium", address: "1 Patriot Pl, Foxborough, MA 02035", time: "8:00 PM", type: "World Cup Group L Match - Marquee Global Matchup", holiday: "World Cup Tournament", demand: "Maximum", priceRange: "$250-$1,500+", distance: 28, audience: "High-spending British and Ghanaian global travelers; total regional sellout" },
  { date: "2026-06-26", name: "FIFA World Cup: Norway vs France", venue: "Gillette Stadium", address: "1 Patriot Pl, Foxborough, MA 02035", time: "4:00 PM", type: "World Cup Group I Match - World Superpower France", holiday: "World Cup Group Stage", demand: "Maximum", priceRange: "$250-$1,400+", distance: 28, audience: "Global soccer enthusiasts, international media, corporate hospitality guests" },
  { date: "2026-06-29", name: "FIFA World Cup: Round of 32 Knockout", venue: "Gillette Stadium", address: "1 Patriot Pl, Foxborough, MA 02035", time: "7:00 PM", type: "World Cup Single-Elimination Knockout Match", holiday: "World Cup Knockout Stage", demand: "Maximum", priceRange: "$300-$1,800+", distance: 28, audience: "High-stakes international crowd, peak summer tourism traffic" },
  { date: "2026-07-09", name: "FIFA World Cup: Quarterfinal Match", venue: "Gillette Stadium", address: "1 Patriot Pl, Foxborough, MA 02035", time: "7:00 PM", type: "World Cup Elite Quarterfinal Spectacle", holiday: "Peak Summer Tourism", demand: "Maximum", priceRange: "$450-$2,500+ (VIP $4,000+)", distance: 28, audience: "Ultra-high-net-worth international visitors, full-state hotel room shortages" },
  { date: "2026-07-30", name: "Monster Jam 2026", venue: "Gillette Stadium", address: "1 Patriot Pl, Foxborough, MA 02035", time: "7:00 PM", type: "Motorsport & Monster Truck Stadium Tour", holiday: "Midsummer Family Season", demand: "High", priceRange: "$45-$180+", distance: 28, audience: "Regional families, motorsport fans, blue-collar travelers" },
  { date: "2026-08-13", name: "Patriots vs Indianapolis Colts (Preseason)", venue: "Gillette Stadium", address: "1 Patriot Pl, Foxborough, MA 02035", time: "7:30 PM", type: "NFL Preseason Game 1 - Season Opener", holiday: "NFL Preseason Kickoff", demand: "High", priceRange: "$60-$220+", distance: 28, audience: "Patriots fans, local tailgaters, Midwest Colts fans" },
];

export const RECURRING_EVENTS = [
  { name: "Marshfield Fair (10-Day Fair)", dayOfWeek: [0, 1, 2, 3, 4, 5, 6], startDate: "2026-08-21", endDate: "2026-08-30", venue: "Marshfield Fairgrounds", address: "140 Main St, Marshfield, MA 02050", time: "12:00 PM-10:00 PM", type: "Agricultural Fair, Demo Derby, Live Music", holiday: "Summer Fair Season", demand: "Moderate to High", priceRange: "$15-$30", distance: 25, audience: "Families, agricultural exhibitors, 4-H travelers" },
  { name: "College Move-in Week", dayOfWeek: [0, 1, 2, 3, 4, 5, 6], startDate: "2026-08-27", endDate: "2026-09-01", venue: "Regional Campuses", address: "Bridgewater, Easton, Norton, Dartmouth, Providence", time: "All Day", type: "Back-to-School Move-in", holiday: "Back-to-School Season", demand: "Very High", priceRange: "Parents/Families", distance: 6, audience: "Budget-conscious families seeking clean highway motels" },
  { name: "King Richard's Renaissance Faire", dayOfWeek: [6, 0], startDate: "2026-09-05", endDate: "2026-10-25", venue: "King Richard's Faire Site", address: "235 Main St, Carver, MA 02330", time: "10:30 AM-6:00 PM", type: "Renaissance Festival", holiday: "Fall Weekend Tourism", demand: "Very High", priceRange: "$45-$50 ($150+ spending inside)", distance: 7, audience: "Costume lovers, families, regional tourists across New England" },
  { name: "Head of the Charles Regatta", dayOfWeek: [5, 6, 0], startDate: "2026-10-16", endDate: "2026-10-18", venue: "Charles River Esplanade", address: "960 Soldiers Field Rd, Boston, MA 02138", time: "8:00 AM-5:00 PM", type: "World's Largest Rowing Race (400,000+)", holiday: "Peak Foliage Weekend", demand: "Very High", priceRange: "Free ($250+ hospitality/travel)", distance: 38, audience: "Collegiate alumni, athletes, international visitors" },
  { name: "America's Hometown Thanksgiving Celebration", dayOfWeek: [5, 6, 0], startDate: "2026-11-20", endDate: "2026-11-22", venue: "Plymouth Waterfront & Memorial Hall", address: "83 Court St & Water St, Plymouth, MA 02360", time: "Parade Sat 10:30 AM", type: "Thanksgiving Parade, Waterfront Village, Concerts", holiday: "Pre-Thanksgiving Weekend", demand: "Very High", priceRange: "Free parade / $25-$60 concerts", distance: 15, audience: "100,000+ spectators, marching band families, heritage tourists" },
  { name: "Thanksgiving Holiday Travel Period", dayOfWeek: [3, 4, 5, 6, 0], startDate: "2026-11-25", endDate: "2026-11-29", venue: "Highway Corridors", address: "I-495, Route 44, Route 28, Route 24", time: "Multi-Day", type: "Cape Cod Gateway Traffic & Family Reunions", holiday: "Thanksgiving Holiday", demand: "High", priceRange: "Family travelers", distance: 0, audience: "Visiting relatives in Southeastern MA without home guest space" },
  { name: "Taunton Christmas City / Lighting of the Green", dayOfWeek: [0, 1, 2, 3, 4, 5, 6], startDate: "2026-12-01", endDate: "2026-12-31", venue: "Taunton Green", address: "Main St & Broadway, Taunton, MA 02780", time: "4:30 PM-10:00 PM", type: "Historic Light Displays", holiday: "Holiday Season", demand: "Moderate to High", priceRange: "Free", distance: 10, audience: "Local & regional holiday tourists, often combined with Edaville" },
  { name: "Edaville Christmas Festival of Lights", dayOfWeek: [3, 4, 5, 6, 0], startDate: "2026-11-15", endDate: "2026-12-31", venue: "Edaville Family Theme Park", address: "5 Pine St, Carver, MA 02330", time: "4:00 PM-9:00 PM", type: "Historic Steam Train & Millions of Holiday Lights", holiday: "Holiday Season Anchor", demand: "High", priceRange: "$30-$45 per person", distance: 7, audience: "Families with young children and grandparents across New England" },
  { name: "Edaville Giving Tree & Charity Weekend", dayOfWeek: [5, 6, 0], startDate: "2026-12-18", endDate: "2026-12-20", venue: "Edaville Family Theme Park", address: "5 Pine St, Carver, MA 02330", time: "4:00 PM-9:00 PM", type: "Holiday Lights & Charity Weekend", holiday: "Pre-Christmas Weekend", demand: "High", priceRange: "$30-$40", distance: 7, audience: "Family holiday getaways" },
  { name: "Edaville 'Let's Glow Crazy' Finale Weekend", dayOfWeek: [6, 0], startDate: "2026-12-26", endDate: "2026-12-28", venue: "Edaville Family Theme Park", address: "5 Pine St, Carver, MA 02330", time: "4:00 PM-9:00 PM", type: "Finale Light Show Weekend", holiday: "School Holiday Break", demand: "High", priceRange: "$30-$40", distance: 7, audience: "Families on school vacation" },
  // ── Historical 2026 H1 (Jan 1 – Aug 19) multi-day events ──
  { name: "MLK Weekend & Winter Sports", dayOfWeek: [5, 6, 0, 1], startDate: "2026-01-16", endDate: "2026-01-19", venue: "TD Garden", address: "100 Legends Way, Boston, MA 02114", time: "Multi-Day", type: "Bruins / Celtics Home Stands & Youth Tournaments", holiday: "MLK Weekend", demand: "Moderate to High", priceRange: "$80-$300+", distance: 38, audience: "Youth sports families, sports fans on 3-day weekend trips" },
  { name: "Presidents' Day & Winter School Break", dayOfWeek: [5, 6, 0, 1], startDate: "2026-02-13", endDate: "2026-02-16", venue: "Amica Mutual Pavilion", address: "1 LaSalle Sq, Providence, RI 02903", time: "Multi-Day", type: "Monster Jam & Regional Family Shows", holiday: "Presidents' Day Weekend", demand: "Moderate to High", priceRange: "$35-$120", distance: 32, audience: "Families with kids traveling during school vacation week" },
  { name: "St. Patrick's Day Weekend in Boston", dayOfWeek: [5, 6, 0, 1, 2], startDate: "2026-03-13", endDate: "2026-03-17", venue: "South Boston / Downtown", address: "Broadway & W 4th St, Boston, MA 02127", time: "Parade Sun 1:00 PM", type: "South Boston Parade, Celtic Punk Shows, Celebrations", holiday: "St. Patrick's Holiday Weekend", demand: "Very High", priceRange: "Free parade / $50-$150 tickets", distance: 36, audience: "1M+ visitors; highway motels absorbed budget overflow" },
  { name: "Hockey East Men's Championship Tournament", dayOfWeek: [5, 6, 0], startDate: "2026-03-20", endDate: "2026-03-22", venue: "TD Garden", address: "100 Legends Way, Boston, MA 02114", time: "Afternoon & Evening Sessions", type: "Collegiate Hockey Championship", holiday: "College Sports Season", demand: "High", priceRange: "$40-$140", distance: 38, audience: "College hockey alumni, student families from MA, NH, ME, VT, RI" },
  { name: "Boston Red Sox Opening Weekend", dayOfWeek: [5, 6, 0], startDate: "2026-04-10", endDate: "2026-04-12", venue: "Fenway Park", address: "4 Jersey St, Boston, MA 02215", time: "1:35 PM / 7:10 PM", type: "Major League Baseball Opening Series", holiday: "Spring Baseball Season", demand: "High", priceRange: "$45-$250+", distance: 38, audience: "Regional baseball enthusiasts, out-of-town traveling fans" },
  { name: "130th Boston Marathon", dayOfWeek: [5, 6, 0, 1], startDate: "2026-04-17", endDate: "2026-04-20", venue: "Hopkinton to Boston", address: "671 Boylston St, Boston, MA 02116", time: "Race Mon 9:00 AM", type: "World Marathon Major (30,000+ runners)", holiday: "Patriots' Day Long Weekend", demand: "Maximum", priceRange: "Free / $250+ runner entry", distance: 35, audience: "Global athletes, families, international tourists filling Eastern MA hotels" },
  { name: "Bridgewater State University Commencement", dayOfWeek: [4, 5], startDate: "2026-05-14", endDate: "2026-05-15", venue: "The Xfinity Center", address: "885 S Main St, Mansfield, MA 02048", time: "Thu 6PM / Fri 10AM & 3PM", type: "Undergraduate & Graduate Degrees", holiday: "College Graduation Season", demand: "Very High", priceRange: "Free commencement tickets", distance: 22, audience: "Families, out-of-state grandparents, relatives filling Middleborough & Mansfield motels" },
  { name: "Major University Commencements", dayOfWeek: [0, 1, 2, 3, 4, 5, 6], startDate: "2026-05-15", endDate: "2026-05-31", venue: "Regional Campuses", address: "Providence, Easton, Norton, Boston", time: "Multi-Day", type: "Brown, Stonehill, Wheaton, Harvard, MIT, BC, BU", holiday: "Graduation Season", demand: "Very High", priceRange: "Family travelers", distance: 15, audience: "Severe shortages pushed families outward along I-495 and Route 44" },
  { name: "Memorial Day Weekend / Cape Cod Travel Rush", dayOfWeek: [5, 6, 0, 1], startDate: "2026-05-22", endDate: "2026-05-25", venue: "Route 44 / I-495 / Route 28 Corridor", address: "Middleborough, MA", time: "All Weekend", type: "Summer Kickoff & Coastal Traffic Gateway", holiday: "Memorial Day Holiday Weekend", demand: "High", priceRange: "Summer tourists & Cape-bound motorists", distance: 0, audience: "Drivers stopping overnight to avoid Bourne Bridge traffic" },
  { name: "NBA Playoffs & Finals / NHL Playoffs", dayOfWeek: [0, 1, 2, 3, 4, 5, 6], startDate: "2026-06-05", endDate: "2026-06-18", venue: "TD Garden", address: "100 Legends Way, Boston, MA 02114", time: "8:00 PM / 8:30 PM", type: "Celtics Championship Run & Playoffs", holiday: "Professional Sports Postseason", demand: "Very High", priceRange: "$250-$1,500+", distance: 38, audience: "Affluent sports fans, national media, corporate travelers" },
  { name: "4th of July & Boston Pops Fireworks Spectacular", dayOfWeek: [5, 6, 0], startDate: "2026-07-03", endDate: "2026-07-05", venue: "Charles River Esplanade / Plymouth Harbor", address: "DCR Hatch Shell, Boston / Water St, Plymouth", time: "Fireworks Jul 4 10:30 PM", type: "Historic Celebrations", holiday: "Independence Day Holiday Weekend", demand: "Very High", priceRange: "Free public events ($150+ spend)", distance: 15, audience: "Holiday tourists, patriotic celebrations, beach travelers" },
  { name: "Phish (2-Night Fenway Run)", dayOfWeek: [5, 6], startDate: "2026-07-31", endDate: "2026-08-01", venue: "Fenway Park", address: "4 Jersey St, Boston, MA 02215", time: "7:00 PM", type: "2-Night Stadium Run", holiday: "Summer Ballpark Tour", demand: "Very High", priceRange: "$90-$350+", distance: 38, audience: "Dedicated traveling jam-band fans booking multi-night stays" },
  { name: "BTS World Tour 'ARIRANG'", dayOfWeek: [3, 4], startDate: "2026-08-05", endDate: "2026-08-06", venue: "Gillette Stadium", address: "1 Patriot Pl, Foxborough, MA 02035", time: "8:00 PM", type: "Global K-Pop Stadium Event (65,000+ nightly)", holiday: "Peak Summer Stadium Series", demand: "Maximum", priceRange: "$180-$850+ (VIP $1,200+)", distance: 28, audience: "International ARMY fanbase; 100% hotel sellout across eastern MA" },
  { name: "Chris Stapleton with Zach Top & Allen Stone", dayOfWeek: [5, 6], startDate: "2026-08-14", endDate: "2026-08-15", venue: "Fenway Park", address: "4 Jersey St, Boston, MA 02215", time: "6:30 PM", type: "2-Night Country Ballpark Concerts", holiday: "Peak Summer Ballpark Series", demand: "Very High", priceRange: "$110-$450+", distance: 38, audience: "Country music enthusiasts, couples, weekend tourists" },
];

export const DEMAND_ORDER = { 'Maximum': 4, 'Very High': 3, 'High': 2, 'Moderate to High': 1.5, 'Moderate': 1 };

export const DEMAND_COLORS = {
  'Maximum': '#FF6B6B',
  'Very High': '#FF8A50',
  'High': '#FFB547',
  'Moderate to High': '#A3E635',
  'Moderate': '#38BDF8',
};

// Smooth distance gradient for proximity styling.
// Stops follow the owner's preferred scale: deep red (0 mi) → red-orange →
// orange → golden yellow → yellow-green → green → blue (40+ mi). Colors are
// interpolated between stops so there are no harsh jumps.
const DISTANCE_STOPS = [
  { mi: 0, color: '#E53935' },   // deep red — very close / highest priority
  { mi: 5, color: '#F4511E' },   // red-orange
  { mi: 10, color: '#FB8C00' },  // orange
  { mi: 15, color: '#FFA726' },  // light orange
  { mi: 20, color: '#FFC107' },  // golden yellow
  { mi: 25, color: '#FDD835' },  // yellow
  { mi: 30, color: '#9CCC65' },  // yellow-green
  { mi: 35, color: '#43A047' },  // green
  { mi: 40, color: '#1E88E5' },  // blue — outside main range
];

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Returns a smooth color for a distance in miles (clamped at the blue stop).
export function distanceColor(miles) {
  const m = Number(miles) || 0;
  if (m <= DISTANCE_STOPS[0].mi) return DISTANCE_STOPS[0].color;
  if (m >= DISTANCE_STOPS[DISTANCE_STOPS.length - 1].mi) return DISTANCE_STOPS[DISTANCE_STOPS.length - 1].color;
  for (let i = 1; i < DISTANCE_STOPS.length; i++) {
    const prev = DISTANCE_STOPS[i - 1];
    const next = DISTANCE_STOPS[i];
    if (m <= next.mi) {
      const t = (m - prev.mi) / (next.mi - prev.mi);
      const a = hexToRgb(prev.color);
      const b = hexToRgb(next.color);
      return rgbToHex(lerp(a.r, b.r, t), lerp(a.g, b.g, t), lerp(a.b, b.b, t));
    }
  }
  return DISTANCE_STOPS[DISTANCE_STOPS.length - 1].color;
}

export function peakDemand(events) {
  return events.reduce((max, e) => Math.max(max, DEMAND_ORDER[e.demand] || 0), 0);
}

// Expand recurring events and return every event (one-time + recurring) whose date
// falls inside [from, to]. Each entry carries a `recurring` boolean so the UI can
// badge it.
export function getEventsInRange({ from = "", to = "" } = {}) {
  if (!from || !to) return [];
  const fromD = new Date(from);
  const toD = new Date(to);
  const events = [];

  EVENT_SCHEDULE.forEach((e) => {
    const d = new Date(e.date);
    if (d >= fromD && d <= toD) events.push({ ...e, recurring: false });
  });

  RECURRING_EVENTS.forEach((r) => {
    const rStart = new Date(r.startDate);
    const rEnd = new Date(r.endDate);
    if (rEnd < fromD || rStart > toD) return;
    const start = rStart > fromD ? rStart : fromD;
    const end = rEnd < toD ? rEnd : toD;
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      if (r.dayOfWeek.includes(d.getDay())) {
        const dateStr = d.toISOString().slice(0, 10);
        events.push({
          date: dateStr,
          name: r.name,
          venue: r.venue,
          address: r.address,
          time: r.time,
          type: r.type,
          holiday: r.holiday,
          demand: r.demand,
          priceRange: r.priceRange,
          distance: r.distance,
          audience: r.audience,
          recurring: true,
        });
      }
    }
  });

  return events.sort((a, b) => a.date.localeCompare(b.date));
}