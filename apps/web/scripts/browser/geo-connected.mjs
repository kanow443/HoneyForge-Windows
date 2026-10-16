import { expect } from '@playwright/test';
import { launch,login,logout,api,baseURL,writeProof,measureViewport,screenshot } from './common.mjs';
const browser=await launch(),context=await browser.newContext({locale:'ru-RU',timezoneId:'Europe/Moscow'}),csrf=await login(context),page=await context.newPage();
const checks=[],viewports=[],screens=[];let metadata=null,privateSource=null,error=null;
try {
  const response=await api(context,'/geo-sources');expect(response.status).toBe(200);
  const data=response.data;metadata={city_database:data.city_database,asn_database:data.asn_database};
  for(const database of Object.values(metadata)){expect(database.status).toBe('available');expect(database.provider).toBe('DB-IP');expect(database.attribution_url).toBe('https://db-ip.com');expect(database.built_at).toMatch(/^2026-10-01T/);expect(database.age_days).not.toBeNull();}
  expect(metadata.city_database.database_type).toBe('DBIP-City-Lite');expect(metadata.asn_database.database_type).toContain('DBIP-ASN-Lite');
  privateSource=data.sources.find(s=>s.reason==='private_or_reserved_address');expect(privateSource).toBeTruthy();expect(privateSource.status).toBe('unavailable');expect(privateSource.country??null).toBeNull();expect(privateSource.city??null).toBeNull();expect(privateSource.asn??null).toBeNull();
  await page.goto(baseURL+'/');await page.getByText('География источников',{exact:true}).click();const geo=page.locator('.geo-sources');await expect(geo.getByRole('link',{name:'DB-IP',exact:true})).toHaveAttribute('href','https://db-ip.com');
  for(const width of [1280,390]){
    await page.setViewportSize({width,height:width===390?844:900});
    await geo.locator('summary').scrollIntoViewIfNeeded();await geo.locator('summary').evaluate(e=>window.scrollBy(0,e.getBoundingClientRect().top-65));
    const displayed=[];
    for(const [label,database] of [['География',metadata.city_database],['ASN',metadata.asn_database]]){
      const row=geo.locator('.geo-databases span').filter({hasText:new RegExp('^'+label+':')});await expect(row).toContainText('база доступна');await expect(row).toContainText('DB-IP');await expect(row).toContainText('возраст '+database.age_days+' дн.');const date=await page.evaluate(value=>new Date(value).toLocaleString('ru-RU',{dateStyle:'medium',timeStyle:'medium'}),database.built_at);await expect(row).toContainText('сборка '+date);displayed.push({label,text:await row.textContent()});
    }
    await expect(geo.getByText(/CC BY 4.0/)).toBeVisible();await expect(geo.locator('.error-notice')).toHaveCount(0);viewports.push(await measureViewport(page,'connected Geo metadata '+width));const metadataScreenshot='geo-connected-metadata-'+width+'.png';await screenshot(page,metadataScreenshot);screens.push(metadataScreenshot);
    const row=geo.locator('tbody tr').filter({has:page.getByText(privateSource.source_ip,{exact:true})});await expect(row).toContainText('Локальный или зарезервированный адрес');await expect(row).toContainText('Не определена');await row.scrollIntoViewIfNeeded();viewports.push(await measureViewport(page,'connected Geo private source '+width));const privateScreenshot='geo-connected-private-'+width+'.png';await screenshot(page,privateScreenshot);screens.push(privateScreenshot);
    checks.push({name:'actual connected Geo/ASN metadata, attribution and private-source unavailable '+width,passed:true,displayed});
  }
} catch(e){error=String(e).split('\n')[0];await screenshot(page,'geo-connected-failed.png').catch(()=>{});}
finally {await writeProof('geo-connected-browser.json',{at:new Date().toISOString(),baseURL,checks,viewports,screens,metadata,private_source:privateSource&&{source_ip:privateSource.source_ip,status:privateSource.status,reason:privateSource.reason,country:privateSource.country??null,city:privateSource.city??null,asn:privateSource.asn??null},error,passed:!error&&checks.length===2&&viewports.length===4,scope:'Read-only actual dashboard/API. No fabricated public events/IPs, no sensor restart, no deployment mutation, no private captures opened. Only own auth session created and logged out.'});await logout(context,csrf);await browser.close();}
if(error){console.error(error);process.exitCode=1;}else console.log(JSON.stringify({passed:true,widths:[390,1280],checks:checks.length,viewports:viewports.length}));
