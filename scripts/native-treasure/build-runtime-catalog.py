"""Build display-only runtime data from the two pinned originals; never import item statistics."""
from pathlib import Path
import argparse, hashlib, json, xml.etree.ElementTree as ET

CATALOG_SHA = '2e970255b8a8fe5a503deea827c4865e651ebecc5ee0666d838030343bc4687c'
TEMPLATES_SHA = 'bbc0d531ddae06043fa9f56478abcb809640981d947bd5ca871379f8944a74bc'
COUNTS = [12,12,12,12,12,9,10,12,5,8,12,6,12,12,12]
NAMES = ['武器','副手','宝珠','戒指手镯','宠物','卡盒','修炼药水','开孔钻头','强化石','合成石','装备碎片','经验药水','项链','专属图鉴','特殊宝物']
sha = lambda data: hashlib.sha256(data).hexdigest()

def build(catalog, templates):
    assert sha(catalog) == CATALOG_SHA and sha(templates) == TEMPLATES_SHA, 'Original input hash mismatch'
    root = ET.fromstring(catalog)
    assert root.tag == 'Result' and root.attrib == {'value':'true','message':'Success!'}
    goods = {}
    for item in ET.fromstring(templates).iter():
        if 'TemplateID' in item.attrib:
            key = int(item.attrib['TemplateID'])
            assert key not in goods, 'Duplicate template'
            goods[key] = item.attrib
    entries = []
    for n, row in enumerate(root,1):
        assert row.tag == 'Item' and set(row.attrib) == {'ID','template','type','count'}
        template, kind, count = [int(row.attrib[k]) for k in ('template','type','count')]
        assert template > 0 and 1 <= kind <= 15 and count > 0
        item = goods[template]
        category, sex = int(item['CategoryID']), int(item['NeedSex'])
        assert category > 0 and 0 <= sex <= 2 and item['Pic'].strip() and item['Name'].strip()
        entries.append(dict(entryKey=f'{CATALOG_SHA}:{n}',sourceRow=n,sourceId=int(row.attrib['ID']),
            sourceOriginalIndex=kind,sourceTemplateId=template,templateId=template,count=count,
            name=item['Name'],categoryId=category,pic=item['Pic'],needSex=sex))
    assert len(entries) == 158 and len({x['templateId'] for x in entries}) == 157
    assert [sum(x['sourceOriginalIndex']==i for x in entries) for i in range(1,16)] == COUNTS
    assert len({tuple(x.values()) for x in entries}) == 158
    assert [(x['sourceOriginalIndex'],x['count']) for x in entries if x['templateId']==11905] == [(7,10),(12,5)]
    categories = [dict(index=i-1,sourceOriginalIndex=i,name=NAMES[i-1],selectable=i<15,special=i==15,
        entryKeys=[x['entryKey'] for x in entries if x['sourceOriginalIndex']==i]) for i in range(1,16)]
    enc = lambda value: json.dumps(value,ensure_ascii=False,separators=(',',':'))
    return ('// Generated display-only data. No private-server statistics, drop weights or runtime paths.\n'
        f'export const treasureCatalogSource = {enc(dict(catalogSha256=CATALOG_SHA,templateDisplaySha256=TEMPLATES_SHA))} as const;\n'
        'export const treasureCategories = [\n'+''.join('  '+enc(x)+',\n' for x in categories)+'] as const;\n'
        'export const treasureEntries = [\n'+''.join('  '+enc(x)+',\n' for x in entries)+'] as const;\n')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog',type=Path,required=True)
    parser.add_argument('--templates',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args = parser.parse_args()
    result = build(args.catalog.read_bytes(),args.templates.read_bytes())
    with args.output.open('x',encoding='utf-8',newline='\n') as output:
        output.write(result)
    print(json.dumps(dict(rows=158,uniqueTemplates=157,categories=15,selectable=14,sha256=sha(result.encode()),statisticsImported=False)))
