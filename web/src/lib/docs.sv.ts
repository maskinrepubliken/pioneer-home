/**
 * All Swedish documentation shown in the Tabeller view: what each table is for, what every column means,
 * the formula cheat sheet, the action grammar and the "så här gör du en ändring" steps.
 *
 * MIRRORS CLAUDE.md (sections "The cell model", "Tables", "Rules", "Actions", "Formula language cheat sheet").
 * When a column, function or action is added or changed there, update this file in the same commit.
 * Ids, formulas, file names and table contents are quoted verbatim; only the explanations are in Swedish.
 */

export type TableGroup = 'house' | 'behaviour' | 'system';

export interface ColumnDoc {
  /** Header name exactly as in the TSV. */
  name: string;
  /** What to write, one or two sentences. */
  what: string;
  /** Allowed values or format, when there is a fixed set. */
  allowed?: string;
  /** A value as it would stand in the cell. */
  example: string;
  /** Which help tab the cell belongs to when editing (adds a "?" affordance and a wide input). */
  help?: HelpTab;
}

export interface TableDoc {
  file: string;
  title: string;
  group: TableGroup;
  /** One sentence: what the table is for. */
  purpose: string;
  /** One short sentence: when a person edits it. */
  whenEdit: string;
  /** A tiny example row or phrase for the overview card, verbatim from the house where possible. */
  example: string;
  /** 2–4 sentences with concrete examples from this house, shown under "Om tabellen". */
  about: string[];
  columns: ColumnDoc[];
  /** For grid tables (scenes): what the user-defined columns mean. */
  dynamicColumns?: ColumnDoc;
}

export type HelpTab = 'formulas' | 'actions' | 'cells';

export const GROUP_TITLE: Record<TableGroup, string> = {
  house: 'Huset',
  behaviour: 'Beteende',
  system: 'System',
};

/** One line under the group title on the overview. */
export const GROUP_LEAD: Record<TableGroup, string> = {
  house: 'Rummen, sakerna i dem och cellerna huset räknar med.',
  behaviour: 'Vad huset gör, och när.',
  system: 'Motorns egna inställningar och vad som sparas. Rörs sällan.',
};

export const GROUP_ORDER: TableGroup[] = ['house', 'behaviour', 'system'];

/** The first sentence is set in Fraunces "ingress", the rest as body text. */
export const OVERVIEW_INTRO: string[] = [
  'Allt i huset är celler med ett värde: en lampas ljusstyrka, temperaturen vid den gula sensorn, om solen är uppe.',
  'Formler räknar fram nya celler ur de som finns, som i ett kalkylblad. Regler tittar på celler och gör saker när något blir sant, eller när klockan slår. Scener och sekvenser är handlingar som går att återanvända.',
  'Allt detta står i sju tabeller, plus en med motorns inställningar. Det som står här är det huset gör, ingenting annat.',
];

export const CHANGE_STEPS: { title: string; text: string }[] = [
  { title: 'Öppna tabellen och tryck på en cell', text: 'Cellen blir ett fält. Skriv, och tryck Enter för raden under eller Tabb för nästa cell. Esc ångrar cellen.' },
  { title: 'Lägg till eller ta bort rader med ⋯', text: 'En regel, en enhet eller en cell per rad. Menyn vid radens högra kant lägger till under, duplicerar och tar bort. + rad längst ner.' },
  { title: 'Vänta på "Inga fel" i Spara-listen', text: 'Listen dyker upp längst ner så snart något är ändrat. Motorn kontrollerar hela konfigurationen; fel pekar på rad och kolumn.' },
  { title: 'Tryck Spara', text: 'Motorn läser in ändringen direkt och den sparas i git på Pi:n. Är något fel sparas ingenting. Ångra allt kastar det du ändrat.' },
];

/** Appended to every table's "Om tabellen" text: how editing works. */
export const EDIT_FLOW = 'Tryck på en cell för att ändra den. Spara-listen dyker upp längst ner när något är ändrat, och ändrade rader får en punkt vid ⋯.';

const NOTE: ColumnDoc = { name: 'note', what: 'Fri anteckning på svenska. Läses av människor, inte av motorn.', example: 'fläkten får gå på natten' };

export const TABLES: TableDoc[] = [
  {
    file: 'rooms.tsv',
    title: 'Rum',
    group: 'house',
    purpose: 'Husets rum: ett id som tabellerna använder och ett namn som människor ser.',
    whenEdit: 'Nästan aldrig. När ett rum byggs, byter namn eller ska heta något annat i historiken.',
    example: 'living_room · living room',
    about: [
      'En enhets rum är en kolumn i Enheter, inte en del av dess id. Flyttar du en sensor ändrar du bara den cellen (room) på enhetens rad; id, regler och historik följer med. Rummet måste vara ett id från den här tabellen, annars säger motorn ifrån.',
      'Varje enhet får två celler ur detta: motion1.room är rummets id (living_room) och motion1.room_name är namnet (living room). Formler kan läsa dem, och Historik skriver room_name som location, så mätserien i PocketBase följer sensorn dit den flyttas.',
      'Namnen står med små bokstäver, precis som i den gamla historiken, så att kurvorna hänger ihop. Gränssnittet sätter stor bokstav själv: Living room.',
    ],
    columns: [
      { name: 'id', what: 'Rummets id. Små bokstäver, ASCII-svenska utan åäö. Skrivs i kolumnen room i Enheter.', example: 'living_room' },
      { name: 'name', what: 'Namnet på svenska med åäö, små bokstäver. Blir <enhet>.room_name och location i historiken.', example: 'living room' },
      { ...NOTE, example: 'rummet med soffan och lampan' },
    ],
  },
  {
    file: 'devices.tsv',
    title: 'Enheter',
    group: 'house',
    purpose: 'En rad per fysisk sak: lampor, sensorer, termostater, fläkten.',
    whenEdit: 'När en ny pryl parats i zigbee2mqtt eller kopplats till GPIO-tjänsten, eller när en sensor flyttar.',
    example: 'lamp1 · living_room · light · z2m:LAMP1',
    about: [
      'Varje enhet har ett eget, beständigt id: samma namn som i zigbee2mqtt fast med små bokstäver (lamp1, motion1, floor1), eller GPIO-tjänstens namn (climate1, climate2, fan). Rummet står aldrig i id:t, det står i kolumnen room och ändras när saken flyttar. Slaget (kind) bestämmer vilka celler enheten får: en lampa får .state, .brightness och .color_temp, en klimatsensor får .temperature och .humidity.',
      'Alla enheter får dessutom .available, .last_seen, .room och .room_name. De två sista speglar kolumnen room och namnet i Rum: motion1.room är living_room, motion1.room_name är living room. Ett bart enhets-id är ett alias för den viktigaste cellen: lamp1 betyder lamp1.state, fan betyder fan.level och motion1 betyder motion1.occupancy.',
      'Källan (source) säger var värdena kommer ifrån: z2m:LAMP1 är det vänliga namnet i zigbee2mqtt, mqtt:home/gpio/climate1 är ett ämne från GPIO-tjänsten på Pi:n.',
    ],
    columns: [
      { name: 'id', what: 'Enhetens eget namn, samma som i zigbee2mqtt fast med små bokstäver. Aldrig rummet: sensorer flyttar.', example: 'lamp1' },
      { name: 'room', what: 'Rummet enheten står i just nu. Ett id från Rum. Läses i formler som <id>.room och <id>.room_name.', allowed: 'ett id i rooms.tsv', example: 'living_room' },
      {
        name: 'kind',
        what: 'Slaget. Bestämmer vilka celler enheten har och hur kommandon översätts till zigbee2mqtt.',
        allowed: 'light, plug, motion, contact, thermostat, remote, climate, pwm',
        example: 'light',
      },
      { name: 'source', what: 'Var värdena kommer ifrån.', allowed: 'z2m:<vänligt namn> eller mqtt:<ämne>', example: 'z2m:LAMP1' },
      { name: 'name', what: 'Visningsnamn på svenska, med åäö. Syns i Live-vyn.', example: 'Lampa LAMP1' },
      { ...NOTE, example: 'Hue colour bulb LCT012' },
    ],
  },
  {
    file: 'cells.tsv',
    title: 'Celler',
    group: 'house',
    purpose: 'Cellerna huset räknar med: trösklar, värden som hålls kvar och formler som räknar fram nya celler.',
    whenEdit: 'När en tröskel ska justeras, när huset behöver minnas ett läge, eller när ett tillstånd ska få ett namn.',
    example: 'fan_target = IF(climate1.temperature <= fan_off_temp, 0, …)',
    about: [
      'Två sorters rader. En rad MED formel är en beräknad cell: den räknas om varje gång något den beror på ändras, eller varje sekund om den beror på klockan. fan_target räknar ut fläktkurvan ur climate1.temperature: 0 vid eller under fan_off_temp, sedan linjärt från fan_min_temp till 100 % vid fan_max_temp. Kolumnen värde till höger visar vad cellen är just nu.',
      'En rad UTAN formel håller ett värde tills en regel eller gränssnittet skriver om det. fan_auto är en sådan: TRUE låter reglerna styra fläkt och luftfuktare i bedroom, FALSE lämnar dem i fred. initial är startvärdet första gången motorn ser cellen; type behövs bara när initial är tomt. Värdet överlever omstarter.',
      'Trösklar är beräknade celler med ett tal som formel: fan_max_temp är 20, dark_elevation är -3, humidifier_on_below är 50. Att ändra ett sådant tal är det vanligaste ingreppet; reglerna läser namnet (sun.elevation < dark_elevation) och behöver inte röras. Kommentarraderna i filen delar upp raderna i trösklar, hållna värden och beräknade.',
    ],
    columns: [
      { name: 'id', what: 'Cellens id. Ett bart namn som säger vad den betyder, små bokstäver och understreck.', example: 'fan_target' },
      {
        name: 'formula',
        what: 'Formeln som räknar fram värdet, eller ett tal för en tröskel. Tomt = cellen håller ett värde som regler och gränssnittet sätter. Se Hjälp → Formler.',
        example: 'IF(AND(fan_auto, night_window), fan_target, 0)',
        help: 'formulas',
      },
      { name: 'initial', what: 'Startvärde för en cell utan formel, första gången motorn ser den. Tomt betyder NULL (okänt).', example: 'TRUE' },
      { name: 'type', what: 'Värdets typ för en cell utan formel. Kan utelämnas när initial är satt.', allowed: 'number, boolean, string, duration, timeofday, timestamp', example: 'boolean' },
      { name: 'room', what: 'Rummet cellen hör till, om den hör till ett. Live visar den då under rummet, i kortet Styrning. Tomt = hela huset.', allowed: 'ett id från Rum (rooms.tsv) eller tomt', example: 'bedroom' },
      { ...NOTE, example: 'fan curve: off at 17, linear 17.5 -> 20, 100% above' },
    ],
  },
  {
    file: 'rules.tsv',
    title: 'Regler',
    group: 'behaviour',
    purpose: 'Beslutstabellen: när något blir sant, eller klockan slår, görs något.',
    whenEdit: 'När huset ska göra något nytt, sluta göra något, eller göra något vid en viss tid.',
    example: 'humid_on · AND(fan_auto, too_dry) → set plug1 on',
    about: [
      'En regel per rad. Med tom when-kolumn fyrar regeln en gång när if går från inte-sant till sant, en stigande kant. humid_on slår på luftfuktaren när AND(fan_auto, too_dry) blir SANT, och fyrar inte igen förrän villkoret varit falskt emellan.',
      'when = on <cell> fyrar vid varje ändring av cellen så länge if är sant. fan_follow gör så: varje gång fan_wanted ändras skickas set fan {fan_wanted}. when = on event fyrar på händelser, som goodnight_evt.',
      'when = at <tid> [dagar] fyrar på klockan. fan_off_morning har at 08:00 daily och stänger av fläkten varje morgon. Dagar skrivs mon-fri, sat-sun, mon,wed eller daily (det som gäller om inget anges). Tiden kan vara relativ till solen: at sunset-30m, at sunrise+1h sat-sun. Ska handlingen bero på husets tillstånd, skriv villkoret i if.',
      'Ett villkor som är OKÄNT (NULL) fyrar aldrig. Använd COALESCE(cell, standardvärde) när regeln måste agera innan sensorn rapporterat. enabled = no stänger av raden utan att ta bort den. Kolumnen senast utlöst till höger visar när regeln fyrade sist i den här körningen.',
    ],
    columns: [
      { name: 'id', what: 'Regelns namn. Syns i Spår-vyn när den fyrar.', example: 'humid_on' },
      {
        name: 'when',
        what: 'När villkoret prövas. Tomt = stigande kant på if (det vanliga). at fyrar på klockan, dagar valfria (daily om inget anges).',
        allowed: 'tomt, on <cell>, on event, at HH:MM [dagar], at sunset-30m, at sunrise+1h sat-sun',
        example: 'at 08:00 daily',
      },
      { name: 'if', what: 'Villkoret, en formel som blir SANT eller FALSKT. Tomt = alltid sant (bara med when).', example: 'AND(fan_auto, too_dry)', help: 'formulas' },
      { name: 'then', what: 'Vad som ska göras. Flera åtgärder skiljs med ;. Se Hjälp → Åtgärder.', example: 'set plug1 on', help: 'actions' },
      { name: 'enabled', what: 'no stänger av regeln. Tomt eller yes = aktiv.', allowed: 'yes, no', example: 'yes' },
      { ...NOTE, example: 'hysteres: på under 50 %' },
    ],
  },
  {
    file: 'scenes.tsv',
    title: 'Scener',
    group: 'behaviour',
    purpose: 'Färdiga ljusbilder: en kolumn per scen, en rad per enhet, cellen säger vad enheten ska sättas till.',
    whenEdit: 'När en stämning ska läggas till eller justeras, till exempel dämpa kvällsljuset.',
    example: 'lamp1 · evening = 60% 2700K',
    about: [
      'Scenen night sätter lamp1 till 10% 2000K. Scenen off släcker lampan och stänger av luftfuktaren plug1. En tom cell betyder att enheten inte rörs i den scenen.',
      'En scen körs med åtgärden scene night, från en regel (även en klockstyrd, when = at 22:00 daily) eller en sekvens. scene off living_room begränsar den till enheterna som just nu står i det rummet. Ny scen = ny kolumn, med knappen + kolumn i rutnätets huvud.',
    ],
    columns: [{ name: 'device', what: 'Enhetens id från Enheter.', example: 'lamp1' }],
    dynamicColumns: {
      name: '<scen>',
      what: 'En kolumn per scen; kolumnnamnet är scenens namn. Cellen är måltillstånd, samma ord som i set. Tomt = rör inte enheten.',
      allowed: 'on, off, 60%, 2700K, color=#ff0000, transition=2s, setpoint=21, ett tal för fläkt',
      example: '10% 2000K',
      help: 'actions',
    },
  },
  {
    file: 'sequences.tsv',
    title: 'Sekvenser',
    group: 'behaviour',
    purpose: 'Handlingar i flera steg med väntetid emellan, som går att avbryta.',
    whenEdit: 'När något ska ske i tur och ordning: dämpa nu, släck om tio minuter om ingen rör sig.',
    example: 'goodnight · steg 2 · after 10m · set lamp1 off',
    about: [
      'goodnight har två steg: scene night direkt, sedan set lamp1 off efter 10m. Steg 2 har cancel_if = motion1, så rör sig någon framför rörelsesensorn i living room under väntan släcks inte lampan.',
      'Sekvensen startas med start goodnight från en regel, en händelse eller ▶-knappen i sidhuvudet, och stoppas med cancel goodnight. En rad med step = * ger ett avbrottsvillkor för hela sekvensen.',
    ],
    columns: [
      { name: 'sequence', what: 'Sekvensens namn. Alla rader med samma namn hör ihop.', example: 'goodnight' },
      { name: 'step', what: 'Stegets nummer i ordning, eller * för ett villkor som gäller hela sekvensen.', allowed: '1, 2, 3 … eller *', example: '2' },
      { name: 'after', what: 'Väntetid efter föregående steg.', allowed: '0s, 30s, 10m, 1h30m', example: '10m' },
      { name: 'action', what: 'Åtgärden som utförs i steget. Se Hjälp → Åtgärder.', example: 'set lamp1 off', help: 'actions' },
      { name: 'cancel_if', what: 'Formel som prövas varje sekund medan steget väntar. Blir den SANT avbryts sekvensen.', example: 'motion1', help: 'formulas' },
      { ...NOTE, example: 'lampan får vara på om någon rör sig' },
    ],
  },
  {
    file: 'history.tsv',
    title: 'Historik',
    group: 'system',
    purpose: 'Vilka celler som sparas till databasen PocketBase, hur ofta och med vilka fältnamn.',
    whenEdit: 'När en ny mätserie ska loggas eller en kurva i Historik-vyn saknas.',
    example: 'climate_1 · temperature = climate1.temperature',
    about: [
      'Rader med samma record bildar en post i PocketBase. climate_1 skriver sensor, location, temperature och humidity från DHT22:an climate1 till samlingen climate, högst var 5m och minst var 30m (hjärtslag), och bara om temperaturen rört sig 0.2 grader eller fuktigheten 1 %.',
      'location är climate1.room_name, alltså rummets namn från Rum. Flyttar sensorn till ett annat rum följer historiken med utan att den här tabellen rörs.',
      'formula kan vara en cell eller ett fast värde: "climate1" eller 10. scale skalar talet innan det sparas, 0.01 gör 54 % till 0.54.',
    ],
    columns: [
      { name: 'record', what: 'Namn som binder ihop raderna till en databaspost.', example: 'climate_1' },
      { name: 'collection', what: 'PocketBase-samlingen posten skrivs till.', allowed: 'climate, weather, heating, power', example: 'climate' },
      { name: 'field', what: 'Fältnamnet i samlingen.', example: 'temperature' },
      { name: 'formula', what: 'Cellen eller formeln som ger värdet, eller ett fast värde i citattecken.', example: 'climate1.temperature', help: 'formulas' },
      { name: 'scale', what: 'Talet multipliceras med detta innan det sparas. Tomt = 1.', example: '0.01' },
      { name: 'min_interval', what: 'Skriv högst så här ofta. Sätts på postens första rad.', allowed: '0s, 5m, 20m', example: '5m' },
      { name: 'max_interval', what: 'Skriv minst så här ofta även om inget ändrats (hjärtslag).', example: '30m' },
      { name: 'min_delta', what: 'Skriv bara om talet rört sig så här mycket sedan förra skrivningen.', example: '0.2' },
      { ...NOTE, example: 'GPIO DHT22 bedroom' },
    ],
  },
  {
    file: 'settings.tsv',
    title: 'Inställningar',
    group: 'system',
    purpose: 'Motorns egna inställningar: tidszon, plats, MQTT-adresser och intervall.',
    whenEdit: 'Nästan aldrig. När Pi:n flyttar, MQTT byter adress eller vädret ska hämtas oftare.',
    example: 'timezone = Europe/Stockholm',
    about: [
      'Det här är konfiguration för motorn, inte för huset. timezone och latitude/longitude ger klockan och solens läge (SUNRISE, SUNSET, sun.elevation). mqtt_url, z2m_base och gpio_base säger var enheterna finns. history_flush och weather_interval styr hur ofta historik skrivs och väder hämtas.',
      'Husets egna tal, som trösklar för fläkten och luftfuktaren, står inte här utan i Celler (fan_max_temp, humidifier_on_below). Varje nyckel här är ändå läsbar som en cell, så en formel kan skriva weather_interval om den behöver.',
    ],
    columns: [
      { name: 'key', what: 'Nyckeln. Blir ett cell-id som formler kan referera till.', example: 'timezone' },
      { name: 'value', what: 'Värdet. Tal, text, tid (10s, 20m) eller klockslag (07:30). Motorn läser typen ur texten.', example: 'Europe/Stockholm' },
      { ...NOTE, example: 'OpenWeatherMap polling interval' },
    ],
  },
];

export function tableDoc(file: string): TableDoc | undefined {
  return TABLES.find((t) => t.file === file);
}

/** Fallback for a TSV the docs do not know: the file name as title. */
export function tableTitle(file: string): string {
  return tableDoc(file)?.title ?? file.replace(/\.tsv$/, '');
}

export function columnDoc(file: string, column: string): ColumnDoc | undefined {
  const t = tableDoc(file);
  if (!t) return undefined;
  const c = t.columns.find((c) => c.name.toLowerCase() === column.toLowerCase());
  if (c) return c;
  if (column.toLowerCase() === 'note') return NOTE;
  return t.dynamicColumns;
}

// ---------------------------------------------------------------------------------------------------------
// Formler
// ---------------------------------------------------------------------------------------------------------

export interface DocExample {
  code: string;
  text: string;
}

export interface DocSection {
  id: string;
  title: string;
  /** Short paragraphs shown above the examples. */
  intro?: string[];
  examples: DocExample[];
}

export const FORMULA_INTRO: string[] = [
  'En formel räknar ut ett värde ur andra celler, som en cell i ett kalkylblad. Celler skrivs med små bokstäver och punkter (climate1.temperature, lamp1.brightness), funktioner med VERSALER (AND, IF, BETWEEN).',
  'Ett värde som ännu inte är känt är NULL. Räkning och jämförelse med NULL ger NULL, och en regel vars villkor är NULL fyrar aldrig. COALESCE(cell, standardvärde) ger ett värde att räkna med tills sensorn rapporterat.',
];

export const FORMULA_SECTIONS: DocSection[] = [
  {
    id: 'literals',
    title: 'Värden',
    intro: ['Tal, text, sant/falskt, tidslängd, klockslag och okänt.'],
    examples: [
      { code: '10', text: 'tal, även 17.5 och -3' },
      { code: '"text"', text: 'text inom raka citattecken' },
      { code: 'TRUE', text: 'sant; FALSE är falskt' },
      { code: '10m', text: 'tidslängd: 30s, 10m, 1h30m, 2d' },
      { code: '07:30', text: 'klockslag' },
      { code: 'NULL', text: 'okänt värde' },
    ],
  },
  {
    id: 'operators',
    title: 'Operatorer',
    intro: ['Inga && eller ||: skriv AND() och OR().'],
    examples: [
      { code: '= <> < <= > >=', text: 'jämför: lika, skilt från, mindre, mindre eller lika, större, större eller lika' },
      { code: '+ - * /', text: 'räknar' },
      { code: '"Temp: " & climate1.temperature', text: '& sätter ihop text' },
    ],
  },
  {
    id: 'logic',
    title: 'Logik',
    examples: [
      { code: 'AND(fan_auto, too_dry)', text: 'sant när alla är sanna' },
      { code: 'OR(motion1, motion2)', text: 'sant när någon är sann' },
      { code: 'NOT(sun.up)', text: 'vänder sant och falskt' },
      { code: 'IF(late_night, 10, 60)', text: 'om villkoret är sant ta det första, annars det andra' },
      { code: 'COALESCE(fan.level, -1)', text: 'det första värdet som inte är NULL' },
      { code: 'ISBLANK(floor2.temperature)', text: 'sant när cellen är NULL' },
    ],
  },
  {
    id: 'math',
    title: 'Matematik',
    examples: [
      { code: 'AVG(a, b)', text: 'medelvärde; även MIN, MAX, SUM, COUNT' },
      { code: 'ABS(x)', text: 'utan tecken' },
      { code: 'ROUND(x)', text: 'avrundar till heltal' },
      { code: 'CLAMP(x, 0, 100)', text: 'begränsar till intervallet' },
      { code: 'BETWEEN(x, 17, 20)', text: 'sant när x ligger i intervallet' },
    ],
  },
  {
    id: 'text',
    title: 'Text',
    examples: [
      { code: 'TEXT(fan.level)', text: 'tal som text' },
      { code: 'LOWER(x)', text: 'små bokstäver; UPPER ger versaler' },
      { code: 'motion1.room_name', text: 'rummets namn där sensorn står, från Rum; motion1.room är rummets id' },
    ],
  },
  {
    id: 'time',
    title: 'Tid',
    intro: ['Formler som använder klockan räknas om varje sekund. Regler fyrar bara på kanten, så det är säkert.'],
    examples: [
      { code: 'TIME()', text: 'klockslaget nu; NOW() är hela tidpunkten' },
      { code: 'BETWEEN(TIME(), 19:30, 06:00)', text: 'tidsfönster, får gå över midnatt' },
      { code: 'HOUR()', text: 'timmen nu (0–23); MINUTE() minuten' },
      { code: 'ISWEEKEND()', text: 'sant lördag och söndag; ISWEEKDAY() vardag; WEEKDAY() ger 1–7' },
      { code: 'TODAY(07:30)', text: 'dagens datum klockan 07:30, som tidpunkt' },
      { code: 'SUNSET()', text: 'solnedgången i dag; SUNRISE() soluppgången' },
      { code: 'MINUTES(10m)', text: 'tidslängd som tal: 10; även HOURS() och SECONDS()' },
    ],
  },
  {
    id: 'history',
    title: 'Historia',
    intro: ['Frågor om vad en cell varit.'],
    examples: [
      { code: 'SINCE(motion1)', text: 'tid sedan cellen senast ändrades' },
      { code: 'SINCE(motion1, TRUE)', text: 'tid sedan cellen senast hade värdet' },
      { code: 'PREV(fan.level)', text: 'värdet före det nuvarande' },
      { code: 'CHANGED(fan_auto)', text: 'sant i det pass cellen ändrades' },
      { code: 'HOLD(too_humid, 2m)', text: 'sant när cellen varit sann oavbrutet så länge' },
    ],
  },
  {
    id: 'idioms',
    title: 'Vanliga mönster',
    examples: [
      { code: 'BETWEEN(TIME(), 19:30, 06:00)', text: 'kväll och natt' },
      { code: 'AND(NOT(motion1), SINCE(motion1, TRUE) > 5m)', text: 'tomt i fem minuter' },
      { code: 'HOLD(too_humid, 2m)', text: 'fuktigt i två minuter i sträck' },
      { code: 'sun.elevation < dark_elevation', text: 'mörkt, med tröskeln från Celler' },
      { code: 'COALESCE(fan.level, -1)', text: 'räkna okänt som -1' },
    ],
  },
];

// ---------------------------------------------------------------------------------------------------------
// Åtgärder
// ---------------------------------------------------------------------------------------------------------

export const ACTION_INTRO: string[] = [
  'En åtgärd är en rad text som säger vad huset ska göra. Flera åtgärder i samma cell skiljs med ;. Åtgärder står i then-kolumnen i Regler, i action-kolumnen i Sekvenser och som måltillstånd i Scener.',
  'Motorn skickar kommandot och väntar på att enheten rapporterar tillbaka. Cellerna ändras först då, aldrig i förskott.',
];

export const ACTION_SECTIONS: DocSection[] = [
  {
    id: 'set',
    title: 'set – sätt en enhet eller variabel',
    examples: [
      { code: 'set lamp1 on', text: 'tänd' },
      { code: 'set lamp1 60% 2700K transition=2s', text: 'ljusstyrka, färgtemperatur och övergångstid' },
      { code: 'set lamp1 brightness+=20%', text: 'relativt: enheten räknar själv' },
      { code: 'set fan 40', text: 'fläktnivå 0–100, eller börvärde på en termostat' },
      { code: 'set floor1 setpoint=21 mode=heat', text: 'termostat' },
      { code: 'set fan_auto FALSE', text: 'skriv en cell utan formel (ett hållet värde)' },
    ],
  },
  {
    id: 'targets',
    title: 'Måltillstånd',
    intro: ['Orden efter enheten i set, och i cellerna i Scener.'],
    examples: [
      { code: 'on', text: 'på; off är av' },
      { code: '60%', text: 'ljusstyrka 0–100 %' },
      { code: '2700K', text: 'färgtemperatur i kelvin' },
      { code: 'color=#ff0000', text: 'färg' },
      { code: 'brightness+=20%', text: 'öka; brightness-=20% minskar' },
      { code: 'transition=2s', text: 'övergångstid' },
      { code: 'setpoint=21', text: 'börvärde; mode=heat driftläge' },
      { code: '40', text: 'ett bart tal: fläktnivå eller börvärde' },
    ],
  },
  {
    id: 'scene',
    title: 'scene – kör en scen',
    examples: [
      { code: 'scene night', text: 'alla enheter i scenen' },
      { code: 'scene off living_room', text: 'bara enheterna som står i ett rum (id från Rum)' },
    ],
  },
  {
    id: 'event',
    title: 'event – skicka en händelse',
    intro: ['Fyrar regler med when = on event och if = event = "namn". Knappar i gränssnittet och fjärrkontroller kan skicka händelser.'],
    examples: [{ code: 'event goodnight', text: 'regeln goodnight_evt fångar den' }],
  },
  {
    id: 'sequence',
    title: 'start och cancel – sekvenser',
    examples: [
      { code: 'start goodnight', text: 'startar om från början om den redan går' },
      { code: 'start goodnight unless running', text: 'startar bara om den inte redan går' },
      { code: 'cancel goodnight', text: 'avbryter' },
    ],
  },
  {
    id: 'fade',
    title: 'fade – tona över tid',
    examples: [{ code: 'fade lamp1 70% 4000K over 20m', text: 'från nuvarande till målet på 20 minuter' }],
  },
  {
    id: 'misc',
    title: 'notify, log, script',
    examples: [
      { code: 'notify "Fläkten står stilla"', text: 'skickar texten till MQTT-ämnet home/notify' },
      { code: 'log "kväll"', text: 'en rad i loggen och i Spår-vyn' },
      { code: 'script morning', text: 'kör tables/scripts/morning.ts. Sista utvägen, skriv varför i note' },
    ],
  },
  {
    id: 'interpolation',
    title: '{formel} i en åtgärd',
    intro: ['Vilket ord som helst i en åtgärd får innehålla en formel inom klammerparenteser. Den räknas ut när åtgärden körs.'],
    examples: [
      { code: 'set fan {fan_wanted}', text: 'nivån från en beräknad cell i Celler' },
      { code: 'set lamp1 on {IF(late_night, "color=#ff0000", "2000K")}', text: 'rött sent på natten, annars varmvitt' },
    ],
  },
];

export const CELLS_INTRO: string[] = [
  'Alla celler motorn känner till just nu, med sitt värde, sorterade efter rummet enheten står i. Klicka på ett id för att sätta in det i cellen du redigerar, eller kopiera det.',
];
