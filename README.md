# 🏎️ Pixel Prix - Mobile-First 2D Top-Down Racing Game

**Pixel Prix** is a high-octane, mobile-first 2D vector racing game built with **Phaser 3**, **Vanilla JavaScript (ES Modules)**, **Vite**, and **Supabase**. It features high-precision car physics, rechargeable boost, invisible checkpoint track validation, thumb-friendly mobile touch controls, live timer HUD, and global circuit leaderboards.

---

## 🚀 Quick Start (Run Locally)

### Prerequisites
Make sure you have [Node.js](https://nodejs.org/) (version 18 or higher) installed on your computer.

### Step 1: Install Dependencies
Open your terminal in the project directory and run:
```bash
npm install
```

### Step 2: Start Local Dev Server
```bash
npm run dev
```
Open the local URL displayed in your terminal (usually `http://localhost:5173`) in your desktop browser or mobile phone browser on the same Wi-Fi network!

---

## 🗄️ Supabase Database Setup Guide (Beginner-Friendly)

Pixel Prix works out of the box using **LocalStorage** if Supabase keys are not set up. To enable global online leaderboards shared across all players, follow these steps to connect Supabase (Free Tier):

### Step 1: Create a Free Supabase Project
1. Go to [supabase.com](https://supabase.com/) and sign up for a free account.
2. Click **"New Project"**, choose a project name (e.g. `pixel-prix-db`), select a database password, and click **"Create New Project"**.

### Step 2: Run the Database Migration
1. In your Supabase project dashboard, click on the **SQL Editor** tab on the left sidebar.
2. Click **"New Query"**, paste the contents of [`supabase/migrations/001_create_scores_table.sql`](supabase/migrations/001_create_scores_table.sql), and click **"Run"**.

### Step 3: Get API Keys & Configure Game
1. In your Supabase dashboard, click the **Settings ⚙️** icon at the bottom of the left sidebar, then click **API**.
2. Copy your **Project URL** and your **`anon` `public` Key**.
3. Create a `.env` file in the project root (copy from `.env.example`):
   ```bash
   cp .env.example .env
   ```
4. Paste your credentials into `.env`:
   ```env
   VITE_SUPABASE_URL=https://your-project-id.supabase.co
   VITE_SUPABASE_ANON_KEY=your-anon-key-here
   ```
5. Save the file. Your game is now fully connected to your Supabase cloud database!

---

## 🌐 Deploy to GitHub Pages (100% Free)

Pixel Prix is pre-configured with a GitHub Actions workflow for automatic deployment to GitHub Pages.

### Step 1: Enable GitHub Pages
1. Go to your repository on GitHub.
2. Click **Settings** → **Pages** (in the left sidebar).
3. Under **Build and deployment** → **Source**, select **GitHub Actions**.

### Step 2: Add Supabase Secrets
1. In your repository, go to **Settings** → **Secrets and variables** → **Actions**.
2. Click **New repository secret** and add the following:
   - Name: `VITE_SUPABASE_URL`
   - Value: Your Supabase Project URL (from Supabase Dashboard → Settings → API)
3. Click **New repository secret** again:
   - Name: `VITE_SUPABASE_ANON_KEY`
   - Value: Your Supabase `anon` `public` Key (from Supabase Dashboard → Settings → API)

### Step 3: Push to Deploy
Push your code to the `main` branch. The GitHub Actions workflow will automatically:
1. Install dependencies
2. Build the project with your Supabase credentials
3. Deploy to GitHub Pages

Your game will be live at: `https://<your-username>.github.io/<repo-name>/`

---

## 🌐 Deploy to Vercel or Netlify (100% Free Static Hosting)

Since Pixel Prix is built as a static site, you can deploy it for free with zero backend server setup.

### Option A: Vercel (Recommended)
1. Push your project repository to GitHub, GitLab, or Bitbucket.
2. Go to [vercel.com](https://vercel.com/) and log in with your Git provider.
3. Click **"Add New Project"** and select your `Pixel Prix` repository.
4. Keep default settings (Vercel automatically detects Vite):
   - **Framework Preset**: Vite
   - **Build Command**: `npm run build`
   - **Output Directory**: `dist`
5. Click **"Deploy"**. Your live game URL will be ready in seconds!

### Option B: Netlify
1. Log in to [netlify.com](https://www.netlify.com/).
2. Click **"Add new site"** -> **"Import an existing project"** and select your GitHub repository.
3. Set build settings:
   - **Build command**: `npm run build`
   - **Publish directory**: `dist`
4. Click **"Deploy site"**.

---

## 🏎️ How to Add New Cars & Circuits (Data-Driven)

You can easily add new cars and tracks without altering any game scene code!

### Adding a New Car
Open [`src/data/cars.js`](file:///c:/Users/adith/Downloads/Work/Projects/G3%20Racing/src/data/cars.js) and add an object to the `CARS` array:

```javascript
{
  id: 'shadow-drift',
  name: 'Shadow Drift',
  description: 'Ultra-light stealth racer with instant cornering agility.',
  color: '#3b82f6',
  accentColor: '#ffffff',
  topSpeed: 235,
  acceleration: 130,
  handling: 4.1,
  boostPower: 1.4,
  drag: 0.984
}
```

### Adding a New Track
Open [`src/data/tracks.js`](file:///c:/Users/adith/Downloads/Work/Projects/G3%20Racing/src/data/tracks.js) and add an object to the `TRACKS` array with path points, road width, and sequential checkpoint coordinates.

---

## 🎮 Game Controls

| Action | Mobile Touch Controls | Desktop Keyboard |
| :--- | :--- | :--- |
| **Steer Left** | ◀ Button (Left Thumb) | `A` or `Left Arrow` |
| **Steer Right** | ▶ Button (Left Thumb) | `D` or `Right Arrow` |
| **Brake / Slow Down** | `BRAKE` Button (Right Thumb) | `S` or `Down Arrow` |
| **Boost Speed** | `BOOST ⚡` Button (Right Thumb) | `Spacebar` or `Shift` |

---

## 🛠️ Built With
- [Phaser 3](https://phaser.io/) - 2D HTML5 Game Engine
- [Supabase](https://supabase.com/) - Open Source Backend Database
- [Vite](https://vitejs.dev/) - Modern Frontend Build Tool
