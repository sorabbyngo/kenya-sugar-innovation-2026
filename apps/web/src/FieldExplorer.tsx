import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'leaflet-draw'
import 'leaflet-draw/dist/leaflet.draw.css'
import './FieldExplorer.css'

type PlaceResult = {
  place_id: number
  display_name: string
  lat: string
  lon: string
}

type AgriculturalProperties = {
  osm_id?: number
  name?: string
  landuse?: string
  crop?: string
  source?: string
  boundary_status?: string
  [key: string]: unknown
}

type AgriculturalFeature = GeoJSON.Feature<
  GeoJSON.Polygon | GeoJSON.MultiPolygon,
  AgriculturalProperties
>

type DrawEvent = L.LeafletEvent & {
  layer: L.Layer
}

const DEFAULT_CENTER: L.LatLngExpression = [-0.5, 37.5]

function polygonAreaSquareMetres(layer: L.Layer): number {
  if (!(layer instanceof L.Polygon)) return 0

  const rings = layer.getLatLngs() as L.LatLng[][]
  const ring = rings[0]
  if (!ring || ring.length < 3) return 0

  const radius = 6378137
  let area = 0

  for (let i = 0; i < ring.length; i += 1) {
    const current = ring[i]
    const next = ring[(i + 1) % ring.length]

    area +=
      ((next.lng - current.lng) * Math.PI / 180) *
      (2 + Math.sin(current.lat * Math.PI / 180) +
        Math.sin(next.lat * Math.PI / 180))
  }

  return Math.abs(area * radius * radius / 2)
}

function formatArea(squareMetres: number): string {
  if (squareMetres >= 1_000_000) {
    return `${(squareMetres / 1_000_000).toFixed(2)} km²`
  }

  return `${(squareMetres / 10_000).toFixed(2)} hectares`
}

function getLayerBounds(layer: L.Layer): L.LatLngBounds | null {
  if ('getBounds' in layer && typeof layer.getBounds === 'function') {
    return layer.getBounds()
  }
  return null
}

export default function FieldExplorer() {
  const mapElement = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const drawnRef = useRef<L.FeatureGroup | null>(null)
  const discoveredRef = useRef<L.GeoJSON | null>(null)
  const selectedRef = useRef<AgriculturalFeature | null>(null)
  const searchCentreRef = useRef<{ lat: number; lon: number } | null>(null)

  const [query, setQuery] = useState('')
  const [countryCode, setCountryCode] = useState('ke')
  const [places, setPlaces] = useState<PlaceResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')

  const [fieldName, setFieldName] = useState('My field')
  const [fieldSummary, setFieldSummary] = useState('No field selected yet')
  const [fieldArea, setFieldArea] = useState('')
  const [fieldCoordinates, setFieldCoordinates] = useState('')
  const [fieldCount, setFieldCount] = useState(0)
  const [boundaryMessage, setBoundaryMessage] = useState(
    'Draw a boundary, import GeoJSON, or discover mapped agricultural areas.',
  )

  const [radius, setRadius] = useState('3000')
  const [discovering, setDiscovering] = useState(false)
  const [discoveryCount, setDiscoveryCount] = useState(0)
  const [discoveryMessage, setDiscoveryMessage] = useState(
    'Search for a place, then discover mapped agricultural areas nearby.',
  )
  const [selectedFeature, setSelectedFeature] =
    useState<AgriculturalFeature | null>(null)
  const [selectedArea, setSelectedArea] = useState('')

  useEffect(() => {
    if (!mapElement.current || mapRef.current) return

    const map = L.map(mapElement.current, {
      center: DEFAULT_CENTER,
      zoom: 6,
      zoomControl: true,
    })

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map)

    const drawn = new L.FeatureGroup()
    map.addLayer(drawn)

    const drawControl = new (L.Control as unknown as {
      Draw: new (options: object) => L.Control
    }).Draw({
      position: 'topleft',
      draw: {
        polygon: { allowIntersection: false, showArea: true },
        rectangle: true,
        polyline: false,
        circle: false,
        circlemarker: false,
        marker: false,
      },
      edit: { featureGroup: drawn, remove: true },
    })

    map.addControl(drawControl)

    const refreshSummary = () => {
      const layers = drawn.getLayers()
      setFieldCount(layers.length)

      if (!layers.length) {
        setFieldSummary('No field selected yet')
        setFieldArea('')
        setFieldCoordinates('')
        return
      }

      const layer = layers[layers.length - 1]
      const bounds = getLayerBounds(layer)
      const centre = bounds?.getCenter()

      if (layer instanceof L.Polygon) {
        setFieldArea(formatArea(polygonAreaSquareMetres(layer)))
      } else {
        setFieldArea('Area available for polygon boundaries')
      }

      if (centre) {
        setFieldCoordinates(
          `${centre.lat.toFixed(6)}, ${centre.lng.toFixed(6)}`,
        )
        setFieldSummary('Field boundary ready')
      }
    }

    map.on('draw:created', (rawEvent: L.LeafletEvent) => {
      const event = rawEvent as DrawEvent
      drawn.addLayer(event.layer)
      setBoundaryMessage('Boundary drawn successfully.')
      refreshSummary()
    })

    map.on('draw:edited', () => {
      setBoundaryMessage('Boundary changes saved on the map.')
      refreshSummary()
    })

    map.on('draw:deleted', () => {
      setBoundaryMessage('Selected boundary removed.')
      refreshSummary()
    })

    mapRef.current = map
    drawnRef.current = drawn

    const resizeTimer = window.setTimeout(() => map.invalidateSize(), 100)

    return () => {
      window.clearTimeout(resizeTimer)
      map.remove()
      mapRef.current = null
      drawnRef.current = null
      discoveredRef.current = null
    }
  }, [])

  async function searchPlaces(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (query.trim().length < 2) {
      setSearchError('Enter at least two characters to search.')
      return
    }

    setSearching(true)
    setSearchError('')
    setPlaces([])

    try {
      const params = new URLSearchParams({
        q: query.trim(),
        format: 'jsonv2',
        addressdetails: '1',
        limit: '7',
      })

      if (countryCode !== 'all') {
        params.set('countrycodes', countryCode)
      }

      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?${params.toString()}`,
        { headers: { Accept: 'application/json' } },
      )

      if (!response.ok) {
        throw new Error('Place search is temporarily unavailable.')
      }

      const results = (await response.json()) as PlaceResult[]
      setPlaces(results)

      if (!results.length) {
        setSearchError(
          'No matching places found. Try a nearby town or a different search.',
        )
      }
    } catch (error) {
      setSearchError(
        error instanceof Error
          ? error.message
          : 'Could not search for that location.',
      )
    } finally {
      setSearching(false)
    }
  }

  function goToPlace(place: PlaceResult) {
    const map = mapRef.current
    if (!map) return

    const latitude = Number(place.lat)
    const longitude = Number(place.lon)

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return

    searchCentreRef.current = { lat: latitude, lon: longitude }
    map.setView([latitude, longitude], 15)

    L.marker([latitude, longitude])
      .addTo(map)
      .bindPopup(place.display_name)
      .openPopup()

    setFieldName(place.display_name.split(',')[0] || 'Selected field')
    setQuery(place.display_name)
    setPlaces([])
    setSearchError('')
    setDiscoveryMessage(
      'Location selected. Choose a radius and discover mapped agricultural areas.',
    )
  }

  async function discoverAgriculturalAreas() {
    const centre = searchCentreRef.current

    if (!centre) {
      setDiscoveryMessage(
        'Search for a place and select a result before discovering fields.',
      )
      return
    }

    const map = mapRef.current
    if (!map) return

    setDiscovering(true)
    setDiscoveryMessage('Searching OpenStreetMap for mapped agricultural areas…')
    setSelectedFeature(null)
    setSelectedArea('')
    selectedRef.current = null

    try {
      const params = new URLSearchParams({
        lat: String(centre.lat),
        lon: String(centre.lon),
        radius,
      })

      const response = await fetch(
        `/api/geospatial/agricultural-polygons?${params.toString()}`,
        { headers: { Accept: 'application/json' } },
      )

      const payload = await response.json().catch(() => null)

      if (!response.ok) {
        const detail =
          payload && typeof payload.detail === 'string'
            ? payload.detail
            : 'The agricultural mapping service is temporarily unavailable.'

        throw new Error(detail)
      }

      if (!payload || !Array.isArray(payload.features)) {
        throw new Error('The mapping service returned an unexpected response.')
      }

      discoveredRef.current?.remove()
      discoveredRef.current = null

      const features = payload.features as AgriculturalFeature[]

      if (!features.length) {
        setDiscoveryCount(0)
        setDiscoveryMessage(
          'No mapped agricultural polygons were found in this radius. Try a larger radius or draw/import the boundary manually.',
        )
        return
      }

      const featureCollection: GeoJSON.FeatureCollection = {
        type: 'FeatureCollection',
        features,
      }

      const layer = L.geoJSON(featureCollection, {
        style: {
          color: '#238653',
          weight: 2,
          opacity: 0.95,
          fillColor: '#67bd83',
          fillOpacity: 0.24,
        },
        onEachFeature: (feature, featureLayer) => {
          const properties = (feature.properties || {}) as AgriculturalProperties
          const label =
            properties.name ||
            properties.crop ||
            properties.landuse ||
            'Mapped agricultural area'

          featureLayer.bindTooltip(String(label), { sticky: true })

          featureLayer.on('mouseover', () => {
            if (featureLayer instanceof L.Path) {
              featureLayer.setStyle({
                color: '#135f38',
                weight: 4,
                fillOpacity: 0.48,
              })
              featureLayer.bringToFront()
            }
          })

          featureLayer.on('mouseout', () => {
            if (featureLayer instanceof L.Path) {
              const isSelected =
                selectedRef.current?.properties?.osm_id === properties.osm_id

              featureLayer.setStyle({
                color: isSelected ? '#d97706' : '#238653',
                weight: isSelected ? 4 : 2,
                fillColor: isSelected ? '#f4b942' : '#67bd83',
                fillOpacity: isSelected ? 0.5 : 0.24,
              })
            }
          })

          featureLayer.on('click', () => {
            selectedRef.current = feature as AgriculturalFeature
            setSelectedFeature(feature as AgriculturalFeature)

            const geoLayer = featureLayer as L.Layer
            const squareMetres = polygonAreaSquareMetres(geoLayer)
            setSelectedArea(formatArea(squareMetres))

            const bounds = getLayerBounds(geoLayer)
            if (bounds?.isValid()) {
              const centrePoint = bounds.getCenter()
              setFieldCoordinates(
                `${centrePoint.lat.toFixed(6)}, ${centrePoint.lng.toFixed(6)}`,
              )
            }

            const name =
              properties.name ||
              properties.crop ||
              properties.landuse ||
              'Mapped agricultural area'

            setFieldSummary('Mapped area selected')
            setFieldName(String(name))
            setFieldArea(formatArea(squareMetres))
            setDiscoveryMessage(
              'Area selected. Review its approximate size, then add it to your editable boundaries if it matches your field.',
            )

            discoveredRef.current?.eachLayer((candidate) => {
              if (candidate instanceof L.Path) {
                candidate.setStyle({
                  color: '#238653',
                  weight: 2,
                  fillColor: '#67bd83',
                  fillOpacity: 0.24,
                })
              }
            })

            if (featureLayer instanceof L.Path) {
              featureLayer.setStyle({
                color: '#d97706',
                weight: 4,
                fillColor: '#f4b942',
                fillOpacity: 0.5,
              })
              featureLayer.bringToFront()
            }
          })
        },
      })

      discoveredRef.current = layer
      layer.addTo(map)

      const bounds = layer.getBounds()
      if (bounds.isValid()) {
        map.fitBounds(bounds.pad(0.12), { maxZoom: 16 })
      }

      setDiscoveryCount(features.length)
      setDiscoveryMessage(
        `Found ${features.length} mapped agricultural area(s). Click a polygon on the map to inspect and select it.`,
      )
    } catch (error) {
      setDiscoveryCount(0)
      const errorMessage =
        error instanceof Error
          ? error.message
          : 'Could not discover agricultural areas. Please try again later.'

      setDiscoveryMessage(
        `${errorMessage} Your drawn boundaries and imported data remain available. You can retry shortly.`,
      )
    } finally {
      setDiscovering(false)
    }
  }

  function addSelectedToBoundaries() {
    const feature = selectedRef.current
    const drawn = drawnRef.current
    const map = mapRef.current

    if (!feature || !drawn || !map) {
      setBoundaryMessage('Select a discovered polygon on the map first.')
      return
    }

    try {
      const imported = L.geoJSON(feature as GeoJSON.GeoJsonObject)
      let added = 0

      imported.eachLayer((layer) => {
        if (layer instanceof L.Polygon || layer instanceof L.Rectangle) {
          drawn.addLayer(layer)
          added += 1
        }
      })

      if (!added) {
        setBoundaryMessage(
          'The selected feature could not be added as a polygon boundary.',
        )
        return
      }

      const bounds = imported.getBounds()
      if (bounds.isValid()) map.fitBounds(bounds.pad(0.12))

      const name =
        feature.properties?.name ||
        feature.properties?.crop ||
        feature.properties?.landuse ||
        'Selected agricultural area'

      setFieldName(String(name))
      setBoundaryMessage(
        'Discovered polygon added to your editable boundaries. Review it carefully before using it for analysis.',
      )

      const layers = drawn.getLayers()
      const latest = layers[layers.length - 1]
      const latestBounds = getLayerBounds(latest)
      const centre = latestBounds?.getCenter()

      setFieldCount(layers.length)
      setFieldSummary('Selected field boundary ready')
      if (latest instanceof L.Polygon) {
        setFieldArea(formatArea(polygonAreaSquareMetres(latest)))
      }
      if (centre) {
        setFieldCoordinates(
          `${centre.lat.toFixed(6)}, ${centre.lng.toFixed(6)}`,
        )
      }
    } catch {
      setBoundaryMessage(
        'Could not add that polygon. You can draw the boundary manually instead.',
      )
    }
  }

  function importGeoJson(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    const drawn = drawnRef.current
    const map = mapRef.current
    if (!file || !drawn || !map) return

    if (
      !file.name.toLowerCase().endsWith('.geojson') &&
      !file.name.toLowerCase().endsWith('.json')
    ) {
      setBoundaryMessage('Please choose a .geojson or GeoJSON .json file.')
      event.target.value = ''
      return
    }

    const reader = new FileReader()

    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as GeoJSON.GeoJsonObject
        const imported = L.geoJSON(parsed)

        if (!imported.getLayers().length) {
          throw new Error('No valid geographic features were found.')
        }

        const supportedLayers: L.Layer[] = []
        imported.eachLayer((layer) => {
          if (layer instanceof L.Polygon || layer instanceof L.Rectangle) {
            supportedLayers.push(layer)
          }
        })

        if (!supportedLayers.length) {
          throw new Error('The file must contain polygon field boundaries.')
        }

        supportedLayers.forEach((layer) => drawn.addLayer(layer))

        const bounds = imported.getBounds()
        if (bounds.isValid()) map.fitBounds(bounds.pad(0.12))

        setBoundaryMessage(
          `Imported ${supportedLayers.length} polygon boundary feature(s) from ${file.name}.`,
        )
        setFieldCount(drawn.getLayers().length)
        setFieldSummary('Imported field boundaries ready')
        setFieldName(file.name.replace(/\.(geojson|json)$/i, ''))
        setFieldCoordinates(
          `${bounds.getCenter().lat.toFixed(6)}, ${bounds.getCenter().lng.toFixed(6)}`,
        )

        const latest = supportedLayers[supportedLayers.length - 1]
        if (latest instanceof L.Polygon) {
          setFieldArea(formatArea(polygonAreaSquareMetres(latest)))
        }
      } catch (error) {
        setBoundaryMessage(
          error instanceof Error
            ? `Import failed: ${error.message}`
            : 'Import failed. Check that the file contains valid GeoJSON.',
        )
      } finally {
        event.target.value = ''
      }
    }

    reader.onerror = () => {
      setBoundaryMessage('The selected file could not be read.')
      event.target.value = ''
    }

    reader.readAsText(file)
  }

  function exportGeoJson() {
    const drawn = drawnRef.current

    if (!drawn || !drawn.getLayers().length) {
      setBoundaryMessage('Draw or import a boundary before exporting.')
      return
    }

    const collection = drawn.toGeoJSON() as GeoJSON.FeatureCollection
    const output: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: collection.features,
    }

    const blob = new Blob([JSON.stringify(output, null, 2)], {
      type: 'application/geo+json',
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')

    link.href = url
    link.download = `${(fieldName.trim() || 'sukarisol-field')
      .replace(/[^a-z0-9-_]+/gi, '-')
      .toLowerCase()}.geojson`

    link.click()
    URL.revokeObjectURL(url)
    setBoundaryMessage('GeoJSON boundary export prepared.')
  }

  function clearBoundaries() {
    drawnRef.current?.clearLayers()
    setFieldCount(0)
    setFieldSummary('No field selected yet')
    setFieldArea('')
    setFieldCoordinates('')
    setBoundaryMessage('Boundaries cleared. Draw or import a new boundary.')
  }

  function clearDiscoveredAreas() {
    discoveredRef.current?.remove()
    discoveredRef.current = null
    selectedRef.current = null
    setSelectedFeature(null)
    setSelectedArea('')
    setDiscoveryCount(0)
    setDiscoveryMessage('Discovered map areas cleared.')
  }

  return (
    <section className="field-explorer-page">
      <div className="field-explorer-intro">
        <div>
          <div className="eyebrow"><span /> SUKARISOL GEOSPATIAL INTELLIGENCE</div>
          <h2>Field Explorer</h2>
          <p>Search places, discover mapped agricultural areas, and prepare field boundaries for satellite analysis.</p>
        </div>
        <span className="field-status-pill">
          <span className="field-status-dot" />
          Map ready
        </span>
      </div>

      <div className="field-explorer-layout">
        <aside className="content-card field-tools">
          <h3>Find a location</h3>
          <p className="field-muted">Search by town, village, address, or place name. Device GPS is not required.</p>

          <form onSubmit={searchPlaces} className="field-search-form">
            <label htmlFor="field-country">Search region</label>
            <select
              id="field-country"
              value={countryCode}
              onChange={(event) => setCountryCode(event.target.value)}
            >
              <option value="ke">Kenya</option>
              <option value="ug">Uganda</option>
              <option value="tz">Tanzania</option>
              <option value="rw">Rwanda</option>
              <option value="et">Ethiopia</option>
              <option value="zm">Zambia</option>
              <option value="mw">Malawi</option>
              <option value="all">Search all countries</option>
            </select>

            <label htmlFor="field-place-search">Place name</label>
            <div className="field-search-row">
              <input
                id="field-place-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="e.g. Mumias, Kakamega"
              />
              <button type="submit" disabled={searching}>
                {searching ? 'Searching…' : 'Search'}
              </button>
            </div>
          </form>

          {searchError && (
            <p className="field-search-message" role="status">{searchError}</p>
          )}

          {places.length > 0 && (
            <div className="field-place-results">
              <strong>Search results</strong>
              {places.map((place) => (
                <button
                  className="field-place-result"
                  type="button"
                  key={place.place_id}
                  onClick={() => goToPlace(place)}
                >
                  <span>{place.display_name}</span>
                  <small>Show on map →</small>
                </button>
              ))}
            </div>
          )}

          <hr />
          <h3>Discover agricultural areas</h3>
          <p className="field-muted">
            Find mapped farmland around your selected place. Coverage depends on OpenStreetMap data.
          </p>

          <label className="field-label" htmlFor="field-discovery-radius">
            Search radius
          </label>
          <select
            id="field-discovery-radius"
            value={radius}
            onChange={(event) => setRadius(event.target.value)}
          >
            <option value="500">500 metres</option>
            <option value="1000">1 kilometre</option>
            <option value="2000">2 kilometres</option>
            <option value="3000">3 kilometres</option>
            <option value="5000">5 kilometres</option>
          </select>

          <button
            type="button"
            className="field-discover-button"
            onClick={discoverAgriculturalAreas}
            disabled={discovering}
          >
            {discovering ? 'Discovering areas…' : 'Discover fields near this place'}
          </button>

          <p className="field-discovery-message" role="status">
            {discoveryMessage}
          </p>

          {!discovering &&
            /temporarily unavailable|temporarily busy|timed out|try again|capacity|502|gateway/i.test(discoveryMessage) && (
              <button
                type="button"
                className="field-secondary-button"
                onClick={discoverAgriculturalAreas}
              >
                Retry agricultural discovery
              </button>
            )}

          <div className="field-discovery-count">
            <strong>{discoveryCount}</strong>
            <span>mapped area{discoveryCount === 1 ? '' : 's'} found</span>
          </div>

          {selectedFeature && (
            <div className="field-selected-area">
              <span className="field-summary-label">MAP SELECTION</span>
              <strong>
                {String(
                  selectedFeature.properties?.name ||
                  selectedFeature.properties?.crop ||
                  selectedFeature.properties?.landuse ||
                  'Mapped agricultural area',
                )}
              </strong>
              <span>Approx. size: {selectedArea || 'Not available'}</span>
              <span className="field-data-warning">
                Mapped land use only; this may not be an individual farm parcel.
              </span>
              <button
                type="button"
                className="field-discover-button"
                onClick={addSelectedToBoundaries}
              >
                Add selected polygon to boundaries
              </button>
            </div>
          )}

          <button
            type="button"
            className="field-secondary-button field-clear-discovery"
            onClick={clearDiscoveredAreas}
          >
            Clear discovered areas
          </button>

          <hr />
          <h3>Field boundary</h3>

          <label className="field-label" htmlFor="field-name">Field name</label>
          <input
            id="field-name"
            className="field-name-input"
            value={fieldName}
            maxLength={120}
            onChange={(event) => setFieldName(event.target.value)}
          />

          <label className="field-import-button">
            <span>Import GeoJSON boundary</span>
            <input
              type="file"
              accept=".geojson,.json,application/geo+json,application/json"
              onChange={importGeoJson}
            />
          </label>

          <div className="field-button-row">
            <button type="button" className="field-secondary-button" onClick={exportGeoJson}>
              Export GeoJSON
            </button>
            <button type="button" className="field-secondary-button" onClick={clearBoundaries}>
              Clear boundaries
            </button>
          </div>

          <p className="field-boundary-message" role="status">{boundaryMessage}</p>

          <div className="field-summary">
            <span className="field-summary-label">CURRENT SELECTION</span>
            <strong>{fieldSummary}</strong>
            <span>{fieldCount} boundary feature{fieldCount === 1 ? '' : 's'}</span>
            {fieldArea && <span>Approx. area: {fieldArea}</span>}
            {fieldCoordinates && <span>Center: {fieldCoordinates}</span>}
          </div>
        </aside>

        <article className="content-card field-map-card">
          <div className="field-map-heading">
            <div>
              <h3>Explore the map</h3>
              <p>Click a discovered agricultural polygon to inspect it, or draw/edit a boundary manually.</p>
            </div>
            <span className="field-map-chip">OpenStreetMap</span>
          </div>

          <div className="field-map-legend">
            <span><i className="field-legend-swatch field-legend-discovered" /> Discovered agricultural area</span>
            <span><i className="field-legend-swatch field-legend-selected" /> Selected area</span>
          </div>

          <p className="field-draw-instructions">
            To draw a farm, select the polygon icon on the map, click each field corner,
            then double-click the final corner to finish. For a rectangular field,
            choose the rectangle tool and drag across the map.
          </p>

          <div className="field-map-canvas" ref={mapElement} aria-label="Interactive agricultural field map" />

          <div className="field-map-footer">
            <span>Basemap and mapped areas © OpenStreetMap contributors</span>
            <span>Mapped agricultural areas are not verified ownership boundaries.</span>
          </div>
        </article>
      </div>

      <article className="content-card field-next-step">
        <div>
          <div className="eyebrow">NEXT DATA LAYER</div>
          <h3>Copernicus Sentinel-2</h3>
          <p>
            Field boundaries are prepared for the next integration: satellite catalogue search,
            image-date selection, cloud filtering, and vegetation-index processing.
          </p>
        </div>
        <span className="field-planned-pill">Satellite connection pending</span>
      </article>
    </section>
  )
}
