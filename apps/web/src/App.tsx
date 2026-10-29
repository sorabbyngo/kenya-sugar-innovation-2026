import { useEffect, useState } from 'react'
import FieldExplorer from './FieldExplorer'
import './App.css'

type DashboardData = {
  farmers_registered: number
  farms_registered: number
  pending_collections: number
  deliveries_today: number
  data_mode: string
}

type Farmer = {
  id: number
  farmer_code: string
  full_name: string
  phone: string | null
  county: string
  sub_county: string | null
  cooperative: string | null
  created_at: string
}

type FarmerForm = {
  full_name: string
  phone: string
  county: string
  sub_county: string
  cooperative: string
}

const emptyFarmerForm: FarmerForm = {
  full_name: '',
  phone: '',
  county: '',
  sub_county: '',
  cooperative: '',
}

const initialData: DashboardData = {
  farmers_registered: 0,
  farms_registered: 0,
  pending_collections: 0,
  deliveries_today: 0,
  data_mode: 'demo',
}

const navigation = [
  { icon: '◫', label: 'Overview' },
  { icon: '✳', label: 'SukariSol AI' },
  { icon: '⌖', label: 'Field Explorer' },
  { icon: '♧', label: 'Farm Registry' },
  { icon: '⇄', label: 'CaneFlow' },
  { icon: '▤', label: 'Mill Operations' },
  { icon: '⌁', label: 'Market & Trade' },
]

function getTimeGreeting() {
  const hour = new Date().getHours()

  if (hour >= 21 || hour < 5) return 'Good night, team.'
  if (hour < 12) return 'Good morning, team.'
  if (hour < 17) return 'Good afternoon, team.'
  return 'Good evening, team.'
}

function App() {
  const [data, setData] = useState<DashboardData>(initialData)
  const [connection, setConnection] = useState<'loading' | 'connected' | 'error'>('loading')
  const [activeNav, setActiveNav] = useState('Overview')
  const [greeting, setGreeting] = useState(getTimeGreeting)
  const [darkMode, setDarkMode] = useState(
    () => window.localStorage.getItem('sukarisol-theme') === 'dark',
  )

  useEffect(() => {
    document.documentElement.dataset.theme = darkMode ? 'dark' : 'light'
    document.documentElement.style.colorScheme = darkMode ? 'dark' : 'light'
    window.localStorage.setItem('sukarisol-theme', darkMode ? 'dark' : 'light')
  }, [darkMode])

  const [lastUpdated, setLastUpdated] = useState('Connecting…')
  const [farmers, setFarmers] = useState<Farmer[]>([])
  const [farmerSearch, setFarmerSearch] = useState('')
  const [farmerLoading, setFarmerLoading] = useState(false)
  const [farmerSaving, setFarmerSaving] = useState(false)
  const [farmerNotice, setFarmerNotice] = useState('')
  const [farmerNoticeType, setFarmerNoticeType] = useState<'success' | 'error'>('success')
  const [farmerForm, setFarmerForm] = useState<FarmerForm>(emptyFarmerForm)
  const [farmerReload, setFarmerReload] = useState(0)
  const [dashboardReload, setDashboardReload] = useState(0)

  const [aiQuestion, setAiQuestion] = useState('')
  const [aiCounty, setAiCounty] = useState('Kisii')
  const [aiCropStage, setAiCropStage] = useState('')
  const [aiAnswer, setAiAnswer] = useState('')
  const [aiError, setAiError] = useState('')
  const [aiLoading, setAiLoading] = useState(false)

  useEffect(() => {
    const updateGreeting = () => setGreeting(getTimeGreeting())
    updateGreeting()
    const greetingInterval = window.setInterval(updateGreeting, 60000)

    return () => window.clearInterval(greetingInterval)
  }, [])

  useEffect(() => {
    let cancelled = false

    async function loadDashboard() {
      try {
        const response = await fetch('http://localhost:8000/api/dashboard')
        if (!response.ok) throw new Error('Dashboard request failed')

        const result = (await response.json()) as DashboardData
        if (cancelled) return

        setData(result)
        setConnection('connected')
        setLastUpdated(
          new Intl.DateTimeFormat('en-KE', {
            hour: '2-digit',
            minute: '2-digit',
          }).format(new Date()),
        )
      } catch {
        if (cancelled) return
        setConnection('error')
        setLastUpdated('API unavailable')
      }
    }

    void loadDashboard()
    const interval = window.setInterval(() => void loadDashboard(), 30000)

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [dashboardReload])

  useEffect(() => {
    if (activeNav !== 'Farm Registry') return

    const controller = new AbortController()

    async function loadFarmers() {
      setFarmerLoading(true)
      try {
        const params = new URLSearchParams({
          search: farmerSearch.trim(),
          limit: '100',
        })
        const response = await fetch(
          `http://localhost:8000/api/farmers?${params.toString()}`,
          { signal: controller.signal },
        )
        if (!response.ok) throw new Error('Could not load farmers.')

        const result = await response.json()
        setFarmers(result.items as Farmer[])
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return
        setFarmerNotice('Unable to load farmers. Check that the API is running.')
        setFarmerNoticeType('error')
      } finally {
        if (!controller.signal.aborted) setFarmerLoading(false)
      }
    }

    void loadFarmers()
    return () => controller.abort()
  }, [activeNav, farmerSearch, farmerReload])

  async function submitFarmer() {
    if (farmerSaving) return

    setFarmerSaving(true)
    setFarmerNotice('')

    try {
      const response = await fetch('http://localhost:8000/api/farmers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full_name: farmerForm.full_name.trim(),
          phone: farmerForm.phone.trim() || null,
          county: farmerForm.county.trim(),
          sub_county: farmerForm.sub_county.trim() || null,
          cooperative: farmerForm.cooperative.trim() || null,
        }),
      })

      const result = await response.json().catch(() => ({}))

      if (!response.ok) {
        const detail = result.detail
        throw new Error(
          typeof detail === 'string'
            ? detail
            : 'Please check the farmer details and try again.',
        )
      }

      setFarmerForm(emptyFarmerForm)
      setFarmerNotice(
        `Farmer registered successfully. SukariSol ID: ${result.farmer_code}`,
      )
      setFarmerNoticeType('success')
      setFarmerReload((value) => value + 1)

      const dashboardResponse = await fetch('http://localhost:8000/api/dashboard')
      if (dashboardResponse.ok) {
        setData((await dashboardResponse.json()) as DashboardData)
      }
    } catch (error) {
      setFarmerNotice(
        error instanceof Error
          ? error.message
          : 'Registration failed. Please try again.',
      )
      setFarmerNoticeType('error')
    } finally {
      setFarmerSaving(false)
    }
  }

  async function submitAiQuestion() {
    if (aiLoading || aiQuestion.trim().length < 5) return

    setAiLoading(true)
    setAiError('')
    setAiAnswer('')

    try {
      const response = await fetch('http://localhost:8000/api/ai/advisory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: aiQuestion.trim(),
          county: aiCounty.trim() || 'Kenya',
          crop_stage: aiCropStage.trim() || null,
        }),
      })

      const result = await response.json().catch(() => ({}))

      if (!response.ok) {
        if (response.status === 504) {
          throw new Error('The AI took too long to respond. Please try again.')
        }
        if ([502, 503].includes(response.status)) {
          throw new Error(
            'The AI service is temporarily unavailable. Check that the local model is running.',
          )
        }
        throw new Error(
          typeof result.detail === 'string'
            ? result.detail
            : `The request failed (HTTP ${response.status}). Please try again.`,
        )
      }

      if (typeof result.answer !== 'string' || !result.answer.trim()) {
        throw new Error('The AI returned an empty response. Please try again.')
      }

      setAiAnswer(result.answer.trim())
    } catch (error) {
      setAiError(
        error instanceof TypeError
          ? 'Could not connect to SukariSol. Check that FastAPI is running on port 8000.'
          : error instanceof Error
            ? error.message
            : 'Something went wrong. Please try again.',
      )
    } finally {
      setAiLoading(false)
    }
  }

  const metrics = [
    {
      label: 'Registered farmers',
      value: data.farmers_registered,
      icon: '♙',
      note: 'Farmer network',
      color: 'mint',
    },
    {
      label: 'Registered farms',
      value: data.farms_registered,
      icon: '♧',
      note: 'Production footprint',
      color: 'gold',
    },
    {
      label: 'Pending collections',
      value: data.pending_collections,
      icon: '⇄',
      note: 'Awaiting collection',
      color: 'blue',
    },
    {
      label: 'Deliveries today',
      value: data.deliveries_today,
      icon: '▤',
      note: 'Daily cane movement',
      color: 'purple',
    },
  ]

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#overview" aria-label="SukariSol home">
          <span className="brand-mark">S<span>+</span></span>
          <span className="brand-copy">
            <strong>SukariSol</strong>
            <small>THE SUGAR VALUE CHAIN</small>
          </span>
        </a>

        <div className="workspace-label">WORKSPACE</div>
        <div className="nav-list">
          {navigation.map((item) => (
            <button
              className={`nav-item ${activeNav === item.label ? 'active' : ''}`}
              key={item.label}
              onClick={() => setActiveNav(item.label)}
              type="button"
            >
              <span className="nav-icon">{item.icon}</span>
              <span>{item.label}</span>
              {item.label === 'CaneFlow' && <span className="nav-dot" />}
            </button>
          ))}
        </div>

        <div className="sidebar-bottom">
          <div className="insight-card">
            <span className="insight-icon">✳</span>
            <strong>Intelligence for every harvest.</strong>
            <p>Connecting farmers, transporters and mills through one platform.</p>
          </div>
          <div className="profile">
            <div className="avatar">SS</div>
            <div className="profile-copy">
              <strong>SukariSol Admin</strong>
              <small>Platform workspace</small>
            </div>
            <span className="profile-menu">···</span>
          </div>
        </div>
      </aside>

      <main className="main-content" id="overview">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Workspace</span><span className="crumb-separator">/</span>
            <strong>{activeNav}</strong>
          </div>
          <div className="topbar-actions">
            <button
              className="theme-toggle"
              type="button"
              onClick={() => setDarkMode((value) => !value)}
              aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
              title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              <span aria-hidden="true">{darkMode ? '☀' : '☾'}</span>
              <span>{darkMode ? 'Light mode' : 'Dark mode'}</span>
            </button>
            <span className={`connection ${connection}`}>
              <span className="status-dot" />
              {connection === 'connected'
                ? 'API connected'
                : connection === 'loading'
                  ? 'Connecting'
                  : 'API unavailable'}
            </span>
            <button className="icon-button" type="button" aria-label="Notifications">♧</button>
            <div className="top-avatar">SS</div>
          </div>
        </header>

        <div className="page-content">
          <section className="welcome-row">
            <div>
              <div className="eyebrow"><span /> SUGAR INDUSTRY · KENYA</div>
              <h1>{activeNav === 'Overview' ? greeting : activeNav}</h1>
              <p className="page-subtitle">
                {activeNav === 'Overview'
                  ? 'Your sugar value chain, at a glance.'
                  : `Explore ${activeNav.toLowerCase()} within the SukariSol platform.`}
              </p>
            </div>
            <div className="welcome-actions">
              <span className="date-chip">◷ &nbsp; Live workspace</span>
              <button
                className="primary-button"
                type="button"
                onClick={() => {
                  setConnection('loading')
                  setDashboardReload((value) => value + 1)
                  if (activeNav === 'Farm Registry') {
                    setFarmerReload((value) => value + 1)
                  }
                }}
              >
                <span>↻</span> Refresh data
              </button>
            </div>
          </section>

          {activeNav === 'Farm Registry' && (
            <section className="registry-page">
              <div className="registry-intro">
                <div>
                  <div className="eyebrow"><span /> GROWER MANAGEMENT</div>
                  <h2>Farm Registry</h2>
                  <p>Register sugarcane growers and manage their records in one place.</p>
                </div>
                <div className="registry-total">
                  <strong>{farmers.length}</strong>
                  <span>Farmers shown</span>
                </div>
              </div>

              {farmerNotice && (
                <div
                  className={`registry-notice ${farmerNoticeType}`}
                  role={farmerNoticeType === 'error' ? 'alert' : 'status'}
                >
                  <span>{farmerNotice}</span>
                  <button
                    type="button"
                    aria-label="Dismiss message"
                    onClick={() => setFarmerNotice('')}
                  >
                    ×
                  </button>
                </div>
              )}

              <article className="content-card registry-form-card">
                <div className="card-heading">
                  <div>
                    <h3>Register a farmer</h3>
                    <p>Fields marked * are required.</p>
                  </div>
                  <span className="registry-form-icon">＋</span>
                </div>

                <form
                  className="registry-form"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void submitFarmer()
                  }}
                >
                  <label>
                    Full name *
                    <input
                      required
                      minLength={2}
                      maxLength={120}
                      value={farmerForm.full_name}
                      onChange={(event) =>
                        setFarmerForm({ ...farmerForm, full_name: event.target.value })
                      }
                      placeholder="e.g. Achieng Otieno"
                    />
                  </label>

                  <label>
                    Phone number
                    <input
                      type="tel"
                      maxLength={30}
                      value={farmerForm.phone}
                      onChange={(event) =>
                        setFarmerForm({ ...farmerForm, phone: event.target.value })
                      }
                      placeholder="e.g. 07XX XXX XXX"
                    />
                  </label>

                  <label>
                    County *
                    <select
                      required
                      value={farmerForm.county}
                      onChange={(event) =>
                        setFarmerForm({ ...farmerForm, county: event.target.value })
                      }
                    >
                      <option value="">Select county</option>
                      {[
                        'Bungoma', 'Busia', 'Kakamega', 'Kisii', 'Kisumu',
                        'Migori', 'Nandi', 'Siaya', 'Trans Nzoia', 'Uasin Gishu',
                        'Kericho', 'Homa Bay', 'Vihiga', 'Other',
                      ].map((county) => (
                        <option key={county} value={county}>{county}</option>
                      ))}
                    </select>
                  </label>

                  <label>
                    Sub-county
                    <input
                      maxLength={100}
                      value={farmerForm.sub_county}
                      onChange={(event) =>
                        setFarmerForm({ ...farmerForm, sub_county: event.target.value })
                      }
                      placeholder="Enter sub-county"
                    />
                  </label>

                  <label className="registry-full-width">
                    Cooperative or grower association
                    <input
                      maxLength={120}
                      value={farmerForm.cooperative}
                      onChange={(event) =>
                        setFarmerForm({ ...farmerForm, cooperative: event.target.value })
                      }
                      placeholder="Enter cooperative name (optional)"
                    />
                  </label>

                  <div className="registry-form-actions registry-full-width">
                    <span>Your farmer ID will be generated automatically.</span>
                    <button className="primary-button" type="submit" disabled={farmerSaving}>
                      {farmerSaving ? 'Saving farmer…' : '＋ Register farmer'}
                    </button>
                  </div>
                </form>
              </article>

              <article className="content-card registry-table-card">
                <div className="card-heading registry-table-heading">
                  <div>
                    <h3>Registered farmers</h3>
                    <p>Search by name, farmer ID, county or cooperative.</p>
                  </div>
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => setFarmerReload((value) => value + 1)}
                  >
                    ↻ Refresh
                  </button>
                </div>

                <div className="registry-search">
                  <span>⌕</span>
                  <input
                    type="search"
                    value={farmerSearch}
                    onChange={(event) => setFarmerSearch(event.target.value)}
                    placeholder="Search farmers…"
                    aria-label="Search registered farmers"
                  />
                  {farmerSearch && (
                    <button type="button" onClick={() => setFarmerSearch('')}>
                      Clear
                    </button>
                  )}
                </div>

                <div className="registry-table-wrap">
                  <table className="registry-table">
                    <thead>
                      <tr>
                        <th>Farmer</th>
                        <th>Farmer ID</th>
                        <th>County / Sub-county</th>
                        <th>Phone</th>
                        <th>Cooperative</th>
                      </tr>
                    </thead>
                    <tbody>
                      {farmerLoading && (
                        <tr><td colSpan={5} className="registry-empty">Loading farmer records…</td></tr>
                      )}
                      {!farmerLoading && farmers.map((farmer) => (
                        <tr key={farmer.id}>
                          <td>
                            <strong>{farmer.full_name}</strong>
                            <small>Registered {new Date(farmer.created_at).toLocaleDateString('en-KE')}</small>
                          </td>
                          <td><span className="farmer-code">{farmer.farmer_code}</span></td>
                          <td>
                            {farmer.county}
                            <small>{farmer.sub_county || 'Sub-county not provided'}</small>
                          </td>
                          <td>{farmer.phone || '—'}</td>
                          <td>{farmer.cooperative || '—'}</td>
                        </tr>
                      ))}
                      {!farmerLoading && farmers.length === 0 && (
                        <tr>
                          <td colSpan={5} className="registry-empty">
                            {farmerSearch
                              ? 'No farmers match your search.'
                              : 'No farmers registered yet. Use the form above to add the first record.'}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="registry-table-footer">
                  Showing {farmers.length} farmer{farmers.length === 1 ? '' : 's'} in this result
                </div>
              </article>
            </section>
          )}

          {activeNav === 'Field Explorer' && <FieldExplorer />}

          {activeNav === 'SukariSol AI' && (
            <section className="ai-page">
              <div className="ai-intro">
                <div>
                  <div className="eyebrow"><span /> SUKARISOL INTELLIGENCE</div>
                  <h2>Sugarcane advisory</h2>
                  <p>Ask practical questions about sugarcane production and field management.</p>
                </div>
                <span className="ai-model-tag">Local AI · DeepSeek</span>
              </div>

              <article className="content-card ai-card">
                <form
                  className="ai-form"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void submitAiQuestion()
                  }}
                >
                  <label>
                    Your question *
                    <textarea
                      required
                      minLength={5}
                      maxLength={2000}
                      rows={5}
                      value={aiQuestion}
                      onChange={(event) => setAiQuestion(event.target.value)}
                      placeholder="e.g. Why are my sugarcane leaves turning yellow during tillering?"
                    />
                  </label>

                  <div className="ai-fields">
                    <label>
                      County
                      <input
                        value={aiCounty}
                        maxLength={80}
                        onChange={(event) => setAiCounty(event.target.value)}
                        placeholder="e.g. Kisii"
                      />
                    </label>
                    <label>
                      Crop stage (optional)
                      <input
                        value={aiCropStage}
                        maxLength={100}
                        onChange={(event) => setAiCropStage(event.target.value)}
                        placeholder="e.g. Tillering"
                      />
                    </label>
                  </div>

                  <div className="ai-actions">
                    <span>Use advice as a starting point. Confirm diagnoses and treatment locally.</span>
                    <button
                      className="primary-button"
                      type="submit"
                      disabled={aiLoading || aiQuestion.trim().length < 5}
                    >
                      {aiLoading ? 'Generating advice…' : 'Get advice →'}
                    </button>
                  </div>
                </form>

                {aiLoading && (
                  <div className="ai-loading" role="status" aria-live="polite">
                    <span className="ai-spinner" />
                    <div>
                      <strong>Analysing your question</strong>
                      <p>The local AI model is preparing a response. This may take a little while.</p>
                    </div>
                  </div>
                )}

                {aiError && (
                  <div className="ai-result ai-error" role="alert">
                    <div className="ai-result-heading">
                      <span className="ai-result-icon">!</span>
                      <div>
                        <strong>We couldn't generate advice</strong>
                        <p>{aiError}</p>
                      </div>
                    </div>
                    <button
                      className="error-retry"
                      type="button"
                      disabled={aiLoading}
                      onClick={() => void submitAiQuestion()}
                    >
                      Try again
                    </button>
                  </div>
                )}

                {aiAnswer && (
                  <div className="ai-result ai-success" aria-live="polite">
                    <div className="ai-result-heading">
                      <span className="ai-result-icon">✳</span>
                      <div>
                        <strong>Your SukariSol advisory</strong>
                        <p>Generated by your local AI model</p>
                      </div>
                    </div>
                    <div className="ai-answer">{aiAnswer}</div>
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => {
                        setAiAnswer('')
                        setAiError('')
                        setAiQuestion('')
                      }}
                    >
                      Ask another question
                    </button>
                  </div>
                )}
              </article>
            </section>
          )}

          {activeNav === 'Overview' && (
            <>
              {connection === 'error' && (
                <div className="error-banner" role="alert">
                  <div>
                    <strong>Could not reach the API.</strong>
                    <span> Displayed figures may be placeholders until the backend reconnects.</span>
                  </div>
                  <button
                    className="error-retry"
                    type="button"
                    onClick={() => {
                      setConnection('loading')
                      setDashboardReload((value) => value + 1)
                    }}
                  >
                    Retry connection
                  </button>
                </div>
              )}

              <section className="metrics-grid" aria-label="Platform metrics">
                {metrics.map((metric, index) => (
                  <article className="metric-card" key={metric.label}>
                    <div className="metric-top">
                      <span className="metric-label">{metric.label}</span>
                      <span className={`metric-icon ${metric.color}`}>{metric.icon}</span>
                    </div>
                    <div className="metric-value">{metric.value.toLocaleString('en-KE')}</div>
                    <div className="metric-footer">
                      <span className="metric-symbol">{['↗', '⌖', '◷', '✓'][index]}</span>
                      <span>{metric.note}</span>
                    </div>
                  </article>
                ))}
              </section>

              <section className="hero-panel">
                <div className="hero-copy">
                  <div className="hero-kicker"><span className="sparkle">✳</span> SUKARISOL INTELLIGENCE</div>
                  <h2>From the field<br />to the factory.</h2>
                  <p>
                    One connected view of Kenya’s sugar value chain.
                    Build visibility across farms, cane movement and mill operations.
                  </p>
                  <button className="hero-button" type="button" onClick={() => setActiveNav('Farm Registry')}>
                    Explore farm registry <span>→</span>
                  </button>
                </div>
                <div className="field-art" aria-hidden="true">
                  <div className="sun" />
                  <div className="field-hill hill-back" />
                  <div className="field-hill hill-front" />
                  <div className="cane cane-one"><i /><i /><i /><i /></div>
                  <div className="cane cane-two"><i /><i /><i /><i /></div>
                  <div className="cane cane-three"><i /><i /><i /><i /></div>
                  <div className="field-path" />
                  <div className="art-caption"><span /> GROWING A CONNECTED FUTURE</div>
                </div>
              </section>

              <section className="lower-grid">
                <article className="content-card operations-card">
                  <div className="card-heading">
                    <div>
                      <h3>Value chain overview</h3>
                      <p>Core operational areas</p>
                    </div>
                    <button className="text-button" type="button" onClick={() => setActiveNav('Farm Registry')}>
                      Explore modules <span>→</span>
                    </button>
                  </div>
                  <div className="operation-list">
                    <div className="operation-row">
                      <div className="operation-icon green">♧</div>
                      <div className="operation-copy"><strong>Farm registry</strong><small>Growers, plots and cane profiles</small></div>
                      <span className="module-status">Foundation</span><span className="row-arrow">↗</span>
                    </div>
                    <div className="operation-row">
                      <div className="operation-icon orange">⇄</div>
                      <div className="operation-copy"><strong>CaneFlow logistics</strong><small>Harvests, transport and deliveries</small></div>
                      <span className="module-status">Operations</span><span className="row-arrow">↗</span>
                    </div>
                    <div className="operation-row">
                      <div className="operation-icon blue">▤</div>
                      <div className="operation-copy"><strong>Mill operations</strong><small>Intake, weighbridge and processing</small></div>
                      <span className="module-status">Operations</span><span className="row-arrow">↗</span>
                    </div>
                    <div className="operation-row">
                      <div className="operation-icon purple">✳</div>
                      <div className="operation-copy"><strong>SukariSol Intelligence</strong><small>Insights and decision support</small></div>
                      <span className="module-status planned">Planned</span><span className="row-arrow">↗</span>
                    </div>
                  </div>
                </article>

                <article className="content-card activity-card">
                  <div className="card-heading">
                    <div>
                      <h3>System status</h3>
                      <p>Application connectivity</p>
                    </div>
                    <span className="live-label"><span /> LIVE</span>
                  </div>
                  <div className="system-status">
                    <div className="system-symbol">⌘</div>
                    <div><strong>Dashboard API</strong><small>FastAPI · localhost:8000</small></div>
                    <span className={`status-pill ${connection}`}>
                      {connection === 'connected' ? 'Connected' : connection === 'loading' ? 'Checking' : 'Offline'}
                    </span>
                  </div>
                  <div className="system-status">
                    <div className="system-symbol web-symbol">◈</div>
                    <div><strong>Web application</strong><small>React · Vite</small></div>
                    <span className="status-pill connected">Running</span>
                  </div>
                  <div className="activity-note">
                    <span className="activity-note-icon">i</span>
                    <p>
                      {connection === 'connected'
                        ? `Dashboard data loaded successfully. Last checked at ${lastUpdated}.`
                        : connection === 'loading'
                          ? 'Waiting for the API to respond.'
                          : 'Check the backend server, then retry the connection.'}
                    </p>
                  </div>
                  <div className="data-mode">
                    <span>DATA ENVIRONMENT</span>
                    <strong><span className="status-dot" /> {data.data_mode.toUpperCase()}</strong>
                  </div>
                </article>
              </section>
            </>
          )}

          {activeNav !== 'Overview' &&
            activeNav !== 'Farm Registry' &&
            activeNav !== 'SukariSol AI' && (
              <section className="content-card coming-soon">
                <div className="operation-icon green">✳</div>
                <h2>{activeNav}</h2>
                <p>This workspace is reserved for the next SukariSol module.</p>
                <p>Its dashboard and workflows can be connected as the backend capabilities are implemented.</p>
              </section>
            )}

          <footer className="page-footer">
            <span>© 2026 SukariSol · Built for Kenya’s sugar value chain.</span>
            <span>Better visibility. Stronger connections. Smarter decisions.</span>
          </footer>
        </div>
      </main>
    </div>
  )
}

export default App
