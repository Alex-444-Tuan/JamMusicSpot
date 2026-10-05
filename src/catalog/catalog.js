// Static track catalog — the only tracks a jam can queue, and the only
// keys the presign route will sign.
//
// Every entry's audio lives in the R2 bucket at tracks/<trackId>.mp3, put there
// by scripts/uploadTracks.mjs. Tracks come from Pixabay Music (Pixabay Content
// License, no attribution required); artist and title were parsed from the
// Pixabay file names (<artist>-<title words>-<id>) and durationMs was measured
// from the files themselves — the player's progress bar and the host's
// auto-advance both depend on it.
//
// trackId must match ^[a-z0-9-]{1,64}$ (it becomes part of the R2 key).

export const TRACK_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

export const catalog = Object.freeze([
    { trackId: 'alec-koff-carnaval-484622', title: 'Carnaval', artist: 'Alec Koff', durationMs: 60552, color: '#7B1754' },
    { trackId: 'alex-makemusic-gorila-315977', title: 'Gorila', artist: 'Alex Makemusic', durationMs: 115488, color: '#036BF6' },
    { trackId: 'alexgrohl-sweet-life-luxury-chill-438146', title: 'Sweet Life Luxury Chill', artist: 'Alexgrohl', durationMs: 102322, color: '#FC0A52' },
    { trackId: 'alexguz-funk-amp-breakbeat-upbeat-advertising-happy-cook-541097', title: 'Funk Amp Breakbeat Upbeat Advertising Happy Cook', artist: 'Alexguz', durationMs: 124839, color: '#AA47F2' },
    { trackId: 'alisiabeats-titanium-170190', title: 'Titanium', artist: 'Alisiabeats', durationMs: 106200, color: '#C185F9' },
    { trackId: 'amaksi-night-detective-226857', title: 'Night Detective', artist: 'Amaksi', durationMs: 115992, color: '#95B672' },
    { trackId: 'audiocopper-dark-571483', title: 'Dark', artist: 'Audiocopper', durationMs: 158485, color: '#A797D9' },
    { trackId: 'audioknap-music-free-458044', title: 'Music Free', artist: 'Audioknap', durationMs: 98116, color: '#7D336D' },
    { trackId: 'bodleasons-alone-296348', title: 'Alone', artist: 'Bodleasons', durationMs: 92839, color: '#E644D5' },
    { trackId: 'bransboynd-fresh-457883', title: 'Fresh', artist: 'Bransboynd', durationMs: 126485, color: '#016A9D' },
    { trackId: 'bransboynd-groovy-vibe-427121', title: 'Groovy Vibe', artist: 'Bransboynd', durationMs: 116637, color: '#681B10' },
    { trackId: 'coma-media-glossy-168156', title: 'Glossy', artist: 'Coma Media', durationMs: 93518, color: '#01F067' },
    { trackId: 'cosmonkey-so-fresh-315255', title: 'So Fresh', artist: 'Cosmonkey', durationMs: 96940, color: '#0206F8' },
    { trackId: 'deltax-music-honey-kisses-413841', title: 'Music Honey Kisses', artist: 'Deltax', durationMs: 156072, color: '#5A2899' },
    { trackId: 'denys-brodovskyi-ethereal-vistas-191254', title: 'Ethereal Vistas', artist: 'Denys Brodovskyi', durationMs: 241737, color: '#4E5D1F' },
    { trackId: 'fassounds-escape-your-love-upbeat-fashion-pop-dance-412230', title: 'Escape Your Love Upbeat Fashion Pop Dance', artist: 'Fassounds', durationMs: 138031, color: '#B7F2E5' },
    { trackId: 'folk-acoustic-music-a-call-to-the-soul-149262', title: 'Acoustic Music A Call To The Soul', artist: 'Folk', durationMs: 159033, color: '#8B627A' },
    { trackId: 'folk-acoustic-summer-walk-152722', title: 'Acoustic Summer Walk', artist: 'Folk', durationMs: 197669, color: '#B1F3D4' },
    { trackId: 'freemusiclab-dark-cyberpunk-i-free-background-music-i-free-music', title: 'Dark Cyberpunk', artist: 'Freemusiclab', durationMs: 118831, color: '#181522' },
    { trackId: 'grand-project-wonders-of-the-earth-550792', title: 'Wonders Of The Earth', artist: 'Grand Project', durationMs: 149603, color: '#654BCB' },
    { trackId: 'gvidon-spinning-head-271171', title: 'Spinning Head', artist: 'Gvidon', durationMs: 128078, color: '#BA4F99' },
    { trackId: 'ilyatruhanov-for-p-453681', title: 'For P', artist: 'Ilyatruhanov', durationMs: 211435, color: '#F10D7B' },
    { trackId: 'itswatr-soulsweeper-252499', title: 'Soulsweeper', artist: 'Itswatr', durationMs: 211513, color: '#40CF89' },
    { trackId: 'kontraa-hype-drill-music-438398', title: 'Hype Drill Music', artist: 'Kontraa', durationMs: 235512, color: '#57E075' },
    { trackId: 'kontraa-unlock-me-amapiano-music-149058', title: 'Unlock Me Amapiano Music', artist: 'Kontraa', durationMs: 185522, color: '#1E458D' },
    { trackId: 'kontraa-water-afro-pop-music-445661', title: 'Water Afro Pop Music', artist: 'Kontraa', durationMs: 69878, color: '#1004B0' },
    { trackId: 'kulakovka-no-copyright-music-270241', title: 'No Copyright Music', artist: 'Kulakovka', durationMs: 195553, color: '#6734DA' },
    { trackId: 'lemonmusicstudio-inside-you-162760', title: 'Inside You', artist: 'Lemonmusicstudio', durationMs: 129437, color: '#B5241E' },
    { trackId: 'lnplusmusic-sport-sports-rock-music-597971', title: 'Sport Sports Rock Music', artist: 'Lnplusmusic', durationMs: 116976, color: '#A3DA1F' },
    { trackId: 'lnplusmusic-suspense-tension-horror-trailer-323181', title: 'Suspense Tension Horror Trailer', artist: 'Lnplusmusic', durationMs: 58880, color: '#A9D189' },
    { trackId: 'mfcc-background-music-274290', title: 'Background Music', artist: 'Mfcc', durationMs: 61571, color: '#BEFEAD' },
    { trackId: 'mfcc-no-copyright-music-261601', title: 'No Copyright Music', artist: 'Mfcc', durationMs: 114887, color: '#67E890' },
    { trackId: 'mickeyscat-moment-of-peace-mickeyscat-554494', title: 'Moment Of Peace Mickeyscat', artist: 'Mickeyscat', durationMs: 152189, color: '#EE2153' },
    { trackId: 'musicdream-dramatic-cinematic-documentary-609202', title: 'Dramatic Cinematic Documentary', artist: 'Musicdream', durationMs: 196807, color: '#E4687C' },
    { trackId: 'nveravetyanmusic-cascade-breathe-future-garage-412839', title: 'Cascade Breathe Future Garage', artist: 'Nveravetyanmusic', durationMs: 138501, color: '#A4D3DB' },
    { trackId: 'nveravetyanmusic-stylish-deep-electronic-262632', title: 'Stylish Deep Electronic', artist: 'Nveravetyanmusic', durationMs: 96026, color: '#58606F' },
    { trackId: 'penguinmusic-better-day-186374', title: 'Better Day', artist: 'Penguinmusic', durationMs: 90697, color: '#F9DDFB' },
    { trackId: 'penguinmusic-future-design-344320', title: 'Future Design', artist: 'Penguinmusic', durationMs: 74031, color: '#B88217' },
    { trackId: 'pumpupthemind-once-in-paris-168895', title: 'Once In Paris', artist: 'Pumpupthemind', durationMs: 132467, color: '#06CC6C' },
    { trackId: 'rockot-drive-breakbeat-173062', title: 'Drive Breakbeat', artist: 'Rockot', durationMs: 109923, color: '#155B9D' },
    { trackId: 'sergepavkinmusic-a-long-way-166385', title: 'A Long Way', artist: 'Sergepavkinmusic', durationMs: 273084, color: '#B7A2B1' },
    { trackId: 'sergepavkinmusic-no-place-to-go-216744', title: 'No Place To Go', artist: 'Sergepavkinmusic', durationMs: 337816, color: '#1D4BF4' },
    { trackId: 'sigmamusicart-football-football-music-551346', title: 'Football Football Music', artist: 'Sigmamusicart', durationMs: 59112, color: '#A9AF36' },
    { trackId: 'sigmamusicart-no-copyright-music-537751', title: 'No Copyright Music', artist: 'Sigmamusicart', durationMs: 123240, color: '#DB9D8A' },
    { trackId: 'sonican-background-music-new-age-nature-465069', title: 'Background Music New Age Nature', artist: 'Sonican', durationMs: 144327, color: '#8983F8' },
    { trackId: 'soulprodmusic-movement-200697', title: 'Movement', artist: 'Soulprodmusic', durationMs: 155115, color: '#00B08E' },
    { trackId: 'syouki-takahashi-midnight-forest-184304', title: 'Midnight Forest', artist: 'Syouki Takahashi', durationMs: 168307, color: '#79AE15' },
    { trackId: 'the-mountain-background-music-159125', title: 'Background Music', artist: 'The Mountain', durationMs: 148846, color: '#1DDD02' },
    { trackId: 'ummbrella-deep-abstract-ambient-snowcap-401656', title: 'Deep Abstract Ambient Snowcap', artist: 'Ummbrella', durationMs: 98586, color: '#DB1DAB' },
    { trackId: 'viacheslavstarostin-chinese-lunar-new-year-465871', title: 'Chinese Lunar New Year', artist: 'Viacheslavstarostin', durationMs: 170710, color: '#007B21' },
]);
