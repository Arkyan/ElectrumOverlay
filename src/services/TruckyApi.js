const axios = require('axios');
const qs = require('qs');
const config = require('../config/store');
const puppeteer = require('puppeteer-core');
const { Launcher } = require('chrome-launcher');

let cachedExecutablePath = null;

/**
 * Résout le chemin d'un Chrome/Edge déjà installé sur la machine (pas de Chromium embarqué).
 */
function resolveExecutablePath() {
    if (cachedExecutablePath) return cachedExecutablePath;

    const installations = Launcher.getInstallations();
    if (installations.length === 0) {
        throw new Error(
            "Aucun navigateur Chrome ou Edge détecté sur cette machine. Installez Google Chrome ou Microsoft Edge pour utiliser l'intégration Trucky."
        );
    }

    cachedExecutablePath = installations[0];
    return cachedExecutablePath;
}

/**
 * Classe pour gérer l'API Trucky
 */
class TruckyApi {
    constructor() {
        this.baseUrl = 'https://e.truckyapp.com/api/';
        this.userId = config.trucky.USER_ID;
    }

    async getUserData() {
        return await this.requestApi(this.baseUrl + `v1/user/${this.userId}`);
    }

    async getUserLastJob() {
        const result = await this.requestApi(this.baseUrl + `v1/user/${this.userId}/jobs`);
        return result.data[0] || null;
    }

    async getCompanyStats(companyId) {
        if (!companyId) {
            throw new Error('Company ID is required to fetch stats');
        }
        return await this.requestApi(this.baseUrl + `v1/company/${companyId}/stats/aggregated`);
    }

    async getCompanyDetails(companyId) {
        if (!companyId) {
            throw new Error('Company ID is required to fetch details');
        }
        return await this.requestApi(this.baseUrl + `v1/company/${companyId}`);
    }

    async requestApi(link) {
        try {
            const browser = await puppeteer.launch({
                executablePath: resolveExecutablePath(),
                headless: 'shell',  // nouveau mode headless
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-gpu',
                    '--disable-dev-shm-usage',
                    '--single-process',
                    '--no-zygote',
                ],
            });
            const page = await browser.newPage();

            // User-Agent réaliste pour ne pas se faire repérer
            await page.setUserAgent(
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                'AppleWebKit/537.36 (KHTML, like Gecko) ' +
                'Chrome/115.0.0.0 Safari/537.36'
            );

            await page.goto(link, {
                waitUntil: 'networkidle2',
            });

            // Attendre un peu que Cloudflare valide le challenge (tu peux aussi attendre un sélecteur ou un délai)
            // await new Promise(resolve => setTimeout(resolve, 2000));

            // Récupérer le contenu après la validation
            const content = await page.evaluate(() => {
                // @ts-ignore
                return document.body.textContent;
            });

            await browser.close();

            // Parser JSON
            const data = JSON.parse(content);
            return data;
        } catch (error) {
            if (error.response) {
                console.log(error.response.data);
            }
            console.error('❌ Erreur lors de la récupération des données utilisateur Trucky:', error.message);
            throw error;
        }
    }

}

module.exports = TruckyApi;
