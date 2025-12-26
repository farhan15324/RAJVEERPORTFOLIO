
// State
let allProjects = [];
let channelCache = {}; // Cache channel data to minimize API calls
let currentFilter = 'all';

document.addEventListener('DOMContentLoaded', () => {
    init();
});

async function init() {
    // Select DOM Elements
    const grid = document.getElementById('projects-grid');
    const filters = document.querySelectorAll('.filter-btn');

    // Initial loading state
    if (grid) grid.innerHTML = '<div class="loading-spinner">Loading Projects...</div>';

    // Event Listeners for Filters
    filters.forEach(btn => {
        btn.addEventListener('click', (e) => {
            // Remove active class from all
            filters.forEach(b => b.classList.remove('active'));
            // Add to clicked
            e.target.classList.add('active');
            // Filter
            const filterType = e.target.getAttribute('data-filter');
            applyFilter(filterType);
        });
    });

    // Close Modals
    setupModals();

    // Fetch Data
    await loadProjects();
}

/**
 * Fetch and Parse CSV from Google Sheet
 */
async function loadProjects() {
    if (!CONFIG.SHEET_CSV_URL || CONFIG.SHEET_CSV_URL.includes('YOUR_')) {
        console.error("Configuration Warning: CSV URL not set.");
        document.getElementById('projects-grid').innerHTML = '<p style="text-align:center;">Please configure the Sheet URL in config.js</p>';
        return;
    }

    try {
        const response = await fetch(CONFIG.SHEET_CSV_URL);
        const csvText = await response.text();

        Papa.parse(csvText, {
            header: true,
            skipEmptyLines: true,
            complete: async (results) => {
                console.log("CSV Parsed:", results);
                if (!results.data || results.data.length === 0) {
                    alert("CSV is empty or could not be read.");
                    return;
                }
                const rawData = results.data;
                await processData(rawData);
            },
            error: (err) => {
                console.error("CSV Parse Error:", err);
                alert("CSV Error: " + JSON.stringify(err));
                document.getElementById('projects-grid').innerHTML = '<p>Error loading projects.</p>';
            }
        });
    } catch (err) {
        console.error("Fetch Error:", err);
        document.getElementById('projects-grid').innerHTML = '<p>Failed to connect to spreadsheet.</p>';
    }
}

/**
 * Process Raw Data: Auto-detect types and fetch YouTube Info Efficiently
 */
async function processData(data) {
    // 1. Sanitize and Normalize
    allProjects = data.map(row => {
        const normalizedRow = {};
        Object.keys(row).forEach(key => {
            normalizedRow[key.trim().toLowerCase()] = row[key];
        });

        // Expected Columns: "Video link", "Shorts link" (new), "thumbnail link (optional)", "Type"

        // Actual CSV Columns: "video_link", "thumbnail_link", "type"

        // 1. Video Link
        let videoLink = normalizedRow['video_link'] || normalizedRow['videolink'] || normalizedRow['video link'] || '';
        const shortsLink = normalizedRow['shorts_link'] || normalizedRow['shorts link'] || '';

        // If Video Link is empty but Shorts Link exists
        if (!videoLink && shortsLink) {
            videoLink = shortsLink;
            if (!normalizedRow['type']) normalizedRow['type'] = 'shorts';
        }

        // 2. Thumbnail Link
        let thumbLink = normalizedRow['thumbnail_link'] || normalizedRow['thumbnaillink'] || normalizedRow['thumbnail link'];
        if (!thumbLink) {
            const thumbKey = Object.keys(normalizedRow).find(k => k.includes('thumbnail'));
            if (thumbKey) thumbLink = normalizedRow[thumbKey];
        }

        // 3. Type
        let type = normalizedRow['type'] || '';

        // Legacy support (variable required by return statement)
        const channelLinkRaw = '';

        // Auto-detect Type
        if (!type) {
            if (shortsLink) type = 'shorts'; // Explicit column
            else if (videoLink.includes('/shorts/')) type = 'shorts';
            else if (videoLink) type = 'video';
            else if (thumbLink) type = 'thumbnail';
        }

        type = type ? type.toLowerCase().trim() : 'video';

        // Extract ID for fetching Channel Info (regardless of Type)
        const videoId = extractVideoId(videoLink);

        return {
            videoLink,
            channelLink: channelLinkRaw,
            thumbLink,
            type,
            videoId,
            channelId: null
        };
    }).filter(p => p.thumbLink || p.videoLink);

    // 2. Batch Fetch Video Details (to get Channel IDs)
    // We only need to fetch for projects that have a Video ID but no explicit manual data overrides?
    // User wants "fetches the channel name n pfp using video link".
    // So we trust the API over the CSV for channel info.

    const videoIdsToFetch = allProjects
        .filter(p => p.videoId) // Only videos
        .map(p => p.videoId);

    // Unique IDs only
    const uniqueVideoIds = [...new Set(videoIdsToFetch)];

    // Batch Fetch (Chunks of 50)
    const vidMap = await batchFetchVideoDetails(uniqueVideoIds);

    // 3. Assign Channel IDs to Projects & Collect Channel IDs to Fetch
    const channelIdsToFetch = new Set();

    allProjects.forEach(p => {
        if (p.videoId && vidMap[p.videoId]) {
            p.channelId = vidMap[p.videoId].channelId;
            p.channelTitle = vidMap[p.videoId].channelTitle; // Temporary store
            channelIdsToFetch.add(p.channelId);

            // If no channel link in CSV, generate one
            if (!p.channelLink) {
                p.channelLink = `https://www.youtube.com/channel/${p.channelId}`;
            }
        }
    });

    // 4. Batch Fetch Channel Details (PFP, Subs)
    const uniqueChannelIds = [...channelIdsToFetch];
    await batchFetchChannelDetails(uniqueChannelIds);

    // 5. Render
    applyFilter('all');
}

/**
 * Batch Fetch Video Details (Limit 50 per call)
 * Returns { videoId: { channelId, channelTitle } }
 */
async function batchFetchVideoDetails(videoIds) {
    if (!CONFIG.YOUTUBE_API_KEY || videoIds.length === 0) return {};

    const map = {};
    const chunkSize = 50;

    for (let i = 0; i < videoIds.length; i += chunkSize) {
        const chunk = videoIds.slice(i, i + chunkSize);
        const ids = chunk.join(',');
        const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${ids}&key=${CONFIG.YOUTUBE_API_KEY}`;

        try {
            const res = await fetch(url);
            const json = await res.json();

            if (json.items) {
                json.items.forEach(item => {
                    map[item.id] = {
                        channelId: item.snippet.channelId,
                        channelTitle: item.snippet.channelTitle
                    };
                });
            }
        } catch (e) {
            console.error("Video Batch Error", e);
        }
    }
    return map;
}

/**
 * Batch Fetch Channel Details (Limit 50 per call)
 * Updates channelCache global object
 */
async function batchFetchChannelDetails(channelIds) {
    if (!CONFIG.YOUTUBE_API_KEY || channelIds.length === 0) return;

    const chunkSize = 50;

    // Filter out already cached
    const needed = channelIds.filter(id => !channelCache[id] && !channelCache[`https://www.youtube.com/channel/${id}`]);
    if (needed.length === 0) return;

    for (let i = 0; i < needed.length; i += chunkSize) {
        const chunk = needed.slice(i, i + chunkSize);
        const ids = chunk.join(',');
        const url = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${ids}&key=${CONFIG.YOUTUBE_API_KEY}`;

        try {
            const res = await fetch(url);
            const json = await res.json();

            if (json.items) {
                json.items.forEach(item => {
                    const cid = item.id;
                    const cLink = `https://www.youtube.com/channel/${cid}`;

                    // Store in cache with ID as key (and Link as alias if needed)
                    // Our createCard looks up by p.channelLink or explicit passed data?
                    // Currently createCard uses `project.channelLink` to look up cache.
                    // So we must ensure cache is keyed by the link we assigned to project.

                    const data = {
                        title: item.snippet.title,
                        pfp: item.snippet.thumbnails.default.url,
                        subs: formatSubs(item.statistics.subscriberCount)
                    };

                    // Cache by ID
                    channelCache[cid] = data;
                    // Cache by constructed link (since existing logic uses link as key)
                    channelCache[cLink] = data;
                });
            }
        } catch (e) {
            console.error("Channel Batch Error", e);
        }
    }
}

function formatSubs(count) {
    if (!count) return '0';
    const num = parseInt(count);
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
}

/**
 * Filter and Render Logic
 */
function applyFilter(filterType) {
    currentFilter = filterType;
    const grid = document.getElementById('projects-grid');

    // 1. Update Grid Classes for Layout Changes
    grid.className = 'projects-grid'; // Reset
    if (filterType !== 'all') {
        grid.classList.add(`mode-${filterType}`);
    }

    // 2. Filter Data
    const validProjects = allProjects.filter(p => {
        if (filterType === 'all') return true;
        return p.type === filterType;
    });

    // 3. Render
    grid.innerHTML = '';
    if (validProjects.length === 0) {
        grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: var(--secondary);">No projects found.</div>';
        return;
    }

    validProjects.forEach(p => {
        const card = createCard(p);
        grid.appendChild(card);
    });
}

function createCard(project) {
    const card = document.createElement('div');
    card.className = 'project-card';

    // Thumbnail Logic
    let thumbSrc = project.thumbLink;
    if (!thumbSrc && project.videoId) {
        thumbSrc = `https://img.youtube.com/vi/${project.videoId}/maxresdefault.jpg`;
    }

    // Channel Data Lookup
    // Priority: Cache by Channel ID -> Cache by Link -> Default
    let chData = {
        title: 'Unknown',
        pfp: 'https://cdn-icons-png.flaticon.com/512/847/847969.png',
        subs: ''
    };

    if (project.channelId && channelCache[project.channelId]) {
        chData = channelCache[project.channelId];
    } else if (project.channelLink && channelCache[project.channelLink]) {
        chData = channelCache[project.channelLink];
    } else if (project.channelTitle) {
        // Fallback to title from Video Snippet if Channel fetch failed
        chData.title = project.channelTitle;
    }

    // Construct HTML (Overlay Structure)
    const thumbDiv = document.createElement('div');
    thumbDiv.className = 'project-thumbnail';
    // Fallback for missing thumb
    thumbDiv.innerHTML = `<img src="${thumbSrc || ''}" onerror="this.src='https://placehold.co/600x400/000/FFF?text=No+Image'" alt="Project" loading="lazy">`;

    // Play button overlay: ONLY if video/shorts type (NOT thumbnail)
    if (project.type === 'video' || project.type === 'shorts') {
        thumbDiv.innerHTML += `<div class="play-overlay"><i class="fa-solid fa-play"></i></div>`;
    }

    const infoDiv = document.createElement('div');
    infoDiv.className = 'project-info';
    infoDiv.innerHTML = `
        <img class="channel-pfp" src="${chData.pfp}" alt="${chData.title}">
        <div class="channel-details">
            <div class="channel-name">${chData.title}</div>
            ${chData.subs ? `<div class="channel-subs">${chData.subs} Subs</div>` : ''}
        </div>
    `;

    card.addEventListener('click', () => {
        // Enforce strict type check: 'thumbnail' ALWAYS opens image modal
        if (project.type === 'thumbnail') {
            openImageModal(thumbSrc);
        } else if (project.type === 'video' || project.type === 'shorts') {
            openVideoModal(project.videoLink);
        } else {
            // Default fallback
            openImageModal(thumbSrc);
        }
    });

    card.appendChild(thumbDiv);
    card.appendChild(infoDiv);

    return card;
}

function extractVideoId(url) {
    // Regex to handle standard, shorts, embed, and shortened URLs
    const regExp = /^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?)|(shorts\/))\??v?=?([^#&?]*).*/;
    const match = url.match(regExp);
    return (match && match[8].length == 11) ? match[8] : false;
}

/* === Modals === */
function setupModals() {
    const vModal = document.getElementById('video-modal');
    const iModal = document.getElementById('image-modal');
    const closeV = document.querySelector('.close-modal');
    const closeI = document.querySelector('.close-modal-img');

    closeV.onclick = () => {
        vModal.style.display = "none";
        document.getElementById('modal-iframe').src = "";
    };

    closeI.onclick = () => {
        iModal.style.display = "none";
    };

    window.onclick = (event) => {
        if (event.target == vModal) {
            vModal.style.display = "none";
            document.getElementById('modal-iframe').src = "";
        }
        if (event.target == iModal) {
            iModal.style.display = "none";
        }
    }
}

function openVideoModal(url) {
    const vModal = document.getElementById('video-modal');
    const iframe = document.getElementById('modal-iframe');
    const vidId = extractVideoId(url);
    if (vidId) {
        iframe.src = `https://www.youtube.com/embed/${vidId}?autoplay=1`;
        vModal.style.display = "flex";
    } else {
        window.open(url, '_blank');
    }
}

function openImageModal(src) {
    const iModal = document.getElementById('image-modal');
    const img = document.getElementById('modal-image');
    img.src = src;
    iModal.style.display = "flex";
}
