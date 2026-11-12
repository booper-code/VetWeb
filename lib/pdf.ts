import type { Consultation, InventoryItem, PatientRecord } from '@/types';

const currency = (value: number) =>
  `PHP ${Number(value || 0).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;

const text = (value: unknown) =>
  value === undefined || value === null || value === '' ? '-' : String(value);

type PdfDoc = InstanceType<typeof import('jspdf').jsPDF> & {
  lastAutoTable?: { finalY: number };
};

const stamp = () => new Date().toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });

const addHeader = (doc: PdfDoc, clinicName: string, title: string, subtitle: string) => {
  const pageWidth = doc.internal.pageSize.getWidth();
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(15, 23, 42);
  doc.text(clinicName || 'Clinic', 40, 46);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(71, 85, 105);
  doc.text(title, 40, 66);

  doc.setFontSize(8);
  doc.setTextColor(100, 116, 139);
  doc.text(subtitle, 40, 80);
  doc.text(`Generated ${stamp()}`, pageWidth - 40, 46, { align: 'right' });

  doc.setDrawColor(226, 232, 240);
  doc.line(40, 90, pageWidth - 40, 90);
};

const addFooters = (doc: PdfDoc) => {
  const pageCount = doc.getNumberOfPages();
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(148, 163, 184);
    doc.text('VetCloudPro', 40, pageHeight - 24);
    doc.text(`Page ${page} of ${pageCount}`, pageWidth - 40, pageHeight - 24, { align: 'right' });
  }
};

const tableTheme = {
  headStyles: { fillColor: [15, 23, 42] as [number, number, number], textColor: 255, fontSize: 8 },
  bodyStyles: { fontSize: 8, textColor: [51, 65, 85] as [number, number, number] },
  alternateRowStyles: { fillColor: [248, 250, 252] as [number, number, number] },
  margin: { left: 40, right: 40 }
};

export const exportInventoryPdf = async ({
  clinicName,
  items
}: {
  clinicName: string;
  items: InventoryItem[];
}) => {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable')
  ]);

  const doc = new jsPDF({ unit: 'pt', format: 'a4' }) as PdfDoc;
  const stockValue = items.reduce((total, item) => total + item.stock * item.buyingPrice, 0);
  const retailValue = items.reduce((total, item) => total + item.stock * item.sellingPrice, 0);
  const lowStock = items.filter(item => item.category !== 'Service' && item.category !== 'Grooming' && item.stock <= item.threshold);

  addHeader(
    doc,
    clinicName,
    'Inventory & Services',
    `${items.length} item(s) · ${lowStock.length} at or below reorder threshold · Stock value ${currency(stockValue)}`
  );

  autoTable(doc, {
    ...tableTheme,
    startY: 104,
    head: [['Code', 'Item / Service', 'Category', 'Stock', 'Buying', 'Selling', 'Reorder At']],
    body: items.map(item => [
      item.itemCode,
      item.itemName,
      item.category,
      item.category === 'Service' || item.category === 'Grooming' ? '-' : String(item.stock),
      item.category === 'Service' || item.category === 'Grooming' ? '-' : currency(item.buyingPrice),
      currency(item.sellingPrice),
      item.category === 'Service' || item.category === 'Grooming' ? '-' : String(item.threshold)
    ]),
    didParseCell: data => {
      if (data.section === 'body' && data.column.index === 3) {
        const item = items[data.row.index];
        if (item && item.category !== 'Service' && item.category !== 'Grooming' && item.stock <= item.threshold) {
          data.cell.styles.textColor = [185, 28, 28];
          data.cell.styles.fontStyle = 'bold';
        }
      }
    }
  });

  const finalY = doc.lastAutoTable?.finalY ?? 120;
  doc.setFontSize(9);
  doc.setTextColor(51, 65, 85);
  doc.text(`Inventory cost value: ${currency(stockValue)}`, 40, finalY + 20);
  doc.text(`Retail value: ${currency(retailValue)}`, 40, finalY + 34);
  if (lowStock.length) {
    doc.setTextColor(185, 28, 28);
    doc.text(`Reorder needed: ${lowStock.map(item => `${item.itemName} (${item.stock})`).join(', ')}`, 40, finalY + 52, {
      maxWidth: doc.internal.pageSize.getWidth() - 80
    });
  }

  addFooters(doc);
  doc.save(`inventory-${new Date().toISOString().slice(0, 10)}.pdf`);
};

export const exportPatientsPdf = async ({
  clinicName,
  patients,
  consultations
}: {
  clinicName: string;
  patients: PatientRecord[];
  consultations: Consultation[];
}) => {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable')
  ]);

  const doc = new jsPDF({ unit: 'pt', format: 'a4' }) as PdfDoc;
  const openBalance = patients.reduce((total, patient) => total + Number(patient.balance || 0), 0);
  const active = patients.filter(patient => patient.status !== 'Discharged');

  addHeader(
    doc,
    clinicName,
    'Admission & Medical Records',
    `${patients.length} patient record(s) · ${active.length} active · ${consultations.length} consultation(s) · Outstanding balance ${currency(openBalance)}`
  );

  autoTable(doc, {
    ...tableTheme,
    startY: 104,
    head: [['ID', 'Patient', 'Species / Breed', 'Owner', 'Contact', 'Status', 'Balance']],
    body: patients.map(patient => [
      patient.id,
      patient.name,
      `${text(patient.species)} / ${text(patient.breed)}`,
      patient.ownerName,
      patient.ownerContact,
      patient.status,
      currency(patient.balance)
    ])
  });

  doc.addPage();
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(15, 23, 42);
  doc.text('Patient charts', 40, 46);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(100, 116, 139);
  doc.text(`Generated ${stamp()}`, doc.internal.pageSize.getWidth() - 40, 46, { align: 'right' });

  let cursor = 66;

  patients.forEach(patient => {
    const patientConsultations = consultations.filter(
      consultation => consultation.patient.toLowerCase() === patient.name.toLowerCase()
    );

    if (cursor > 680) {
      doc.addPage();
      cursor = 50;
    }

    doc.setDrawColor(226, 232, 240);
    doc.line(40, cursor, doc.internal.pageSize.getWidth() - 40, cursor);
    cursor += 16;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(15, 23, 42);
    doc.text(`${patient.name} · ${patient.id}`, 40, cursor);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(71, 85, 105);
    doc.text(patient.status, doc.internal.pageSize.getWidth() - 40, cursor, { align: 'right' });
    cursor += 14;

    const details = [
      `Owner: ${patient.ownerName} · ${patient.ownerContact}${patient.ownerEmail ? ` · ${patient.ownerEmail}` : ''}`,
      `Signalment: ${text(patient.species)} · ${text(patient.breed)} · ${patient.gender} · ${patient.weight} kg`,
      `Admission: ${patient.admissionTypes?.join(', ') || '-'} · Reason: ${text(patient.reason)}`,
      `Balance: ${currency(patient.balance)}`
    ];

    if (patient.notes) details.push(`Notes: ${patient.notes}`);
    if (patient.labResults?.length) {
      details.push(
        `Labs: ${patient.labResults
          .map(lab => `${lab.testName} (${lab.date})${lab.findings ? `: ${lab.findings}` : ''}`)
          .join(' | ')}`
      );
    }

    doc.setTextColor(51, 65, 85);
    details.forEach(detail => {
      const lines = doc.splitTextToSize(detail, doc.internal.pageSize.getWidth() - 80);
      doc.text(lines, 40, cursor);
      cursor += lines.length * 10 + 3;
    });

    if (patientConsultations.length) {
      autoTable(doc, {
        ...tableTheme,
        startY: cursor + 4,
        head: [['Consultation', 'Date', 'Type', 'Status', 'Notes']],
        body: patientConsultations.map(consultation => [
          consultation.id,
          consultation.date,
          consultation.type,
          consultation.status,
          consultation.notes
        ])
      });
      cursor = (doc.lastAutoTable?.finalY ?? cursor) + 18;
    } else {
      cursor += 6;
    }
  });

  addFooters(doc);
  doc.save(`patient-records-${new Date().toISOString().slice(0, 10)}.pdf`);
};
