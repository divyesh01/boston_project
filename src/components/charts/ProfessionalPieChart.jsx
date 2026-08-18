import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip } from 'recharts';

export function ProfessionalPieChart({ data, title, width = '100%', height = 600 }) {
  if (!data || data.length === 0) {
    return <div>No data available</div>;
  }

  return (
    <div style={{ width, height, padding: '20px', backgroundColor: '#f9f9f9', borderRadius: '8px' }}>
      <h2 style={{ marginBottom: '20px', color: '#333' }}>{title}</h2>
      <ResponsiveContainer width="100%" height={height - 60}>
        <PieChart>
          <Pie
            data={data}
            cx="35%"
            cy="50%"
            labelLine={true}
            label={({ name, value, percent }) => {
              const numVal = Number(value);
              const formatted = numVal >= 1000 ? `$${(numVal / 1000).toFixed(1)}k` : `$${numVal.toFixed(0)}`;
              return `${name}: ${formatted} (${(percent * 100).toFixed(1)}%)`;
            }}
            outerRadius={100}
            fill="#8884d8"
            dataKey="value"
          >
            {data.map((entry, index) => (
              <Cell key={`cell-${index}`} fill={entry.color} />
            ))}
          </Pie>
          <Tooltip 
            formatter={(value) => {
              const numVal = Number(value);
              if (numVal >= 1000) return `$${(numVal / 1000).toFixed(1)}k`;
              return `$${numVal.toFixed(2)}`;
            }}
            contentStyle={{ backgroundColor: '#fff', border: '1px solid #ccc' }}
          />
          <Legend 
            verticalAlign="bottom" 
            height={36}
            wrapperStyle={{ paddingTop: '20px' }}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
